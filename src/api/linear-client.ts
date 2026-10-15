/**
 * Linear API Client
 * Secure utility for managing Linear issues, projects, and workflow integration via official Linear SDK
 */

import { LinearClient as LinearSDK } from "@linear/sdk";
import type {
	LinearComment,
	LinearIntegrationConfig,
	LinearIssue,
	LinearIssueLabel,
	LinearIssueStatus,
	LinearPriority,
	LinearProject,
	LinearTeam,
	LinearUser,
} from "../../types/linear.js";
import type { ProcessedFeedbackData } from "../../types/testflight.js";
import {
	DEFAULT_LABEL_CONFIG,
	ERROR_MESSAGES,
	PRIORITY_LEVELS,
	getConfiguration,
} from "../config/index.js";

/**
 * Linear API Client with official SDK integration, rate limiting awareness, and secure configuration
 */
export class LinearClient {
	private readonly config: LinearIntegrationConfig;
	private readonly sdk: LinearSDK;
	private teamCache: LinearTeam | null = null;

	constructor() {
		const envConfig = getConfiguration();

		if (!envConfig.linear) {
			throw new Error(ERROR_MESSAGES.LINEAR_CONFIG_MISSING);
		}

		this.config = {
			apiToken: envConfig.linear.apiToken,
			teamId: envConfig.linear.teamId,
			defaultPriority: PRIORITY_LEVELS.NORMAL,
			defaultLabels: [...DEFAULT_LABEL_CONFIG.defaultLabels],
			crashLabels: [...DEFAULT_LABEL_CONFIG.crashLabels],
			feedbackLabels: [...DEFAULT_LABEL_CONFIG.feedbackLabels],
			enableDuplicateDetection: true,
			duplicateDetectionDays: 7,
		};

		// Initialize the Linear SDK
		this.sdk = new LinearSDK({
			apiKey: this.config.apiToken,
		});
	}

	/**
	 * Creates a Linear issue from TestFlight feedback data
	 */
	public async createIssueFromTestFlight(
		feedback: ProcessedFeedbackData,
		additionalLabels: string[] = [],
		assigneeId?: string,
		projectId?: string,
		options?: {
			customTitle?: string;
			customDescription?: string;
			priority?: LinearPriority;
			requireTriage?: boolean;
		},
	): Promise<LinearIssue> {
		try {
			// Check for duplicates if enabled
			if (this.config.enableDuplicateDetection) {
				const duplicateIssue = await this.findDuplicateIssue(feedback);
				if (duplicateIssue) {
					console.log(
						`Duplicate issue found: ${duplicateIssue.identifier}. Leaving existing issue unchanged.`,
					);
					return duplicateIssue;
				}
			}

			const stateId = await this.validateDestination(projectId, options?.requireTriage ?? false);
			feedback = await this.preserveAssets(feedback);
			const issueData = this.prepareIssueFromTestFlight(
				feedback,
				additionalLabels,
				assigneeId,
				projectId,
				options,
			);

			// Create issue using Linear SDK
			const issueCreatePayload = await this.sdk.createIssue({
				title: issueData.title,
				description: issueData.description,
				teamId: issueData.teamId,
				priority: this.mapPriorityToLinearPriority(issueData.priority),
				assigneeId: issueData.assigneeId,
				projectId: issueData.projectId,
				stateId,
			});

			if (!issueCreatePayload.success) {
				throw new Error("Linear API error: Failed to create issue");
			}

			const createdIssue = await issueCreatePayload.issue;
			if (!createdIssue) {
				throw new Error("Failed to retrieve created issue from Linear");
			}

			// Convert to simplified LinearIssue format
			const linearIssue: LinearIssue =
				await this.convertToLinearIssue(createdIssue);

			console.log(
				`✅ Created Linear issue: ${linearIssue.identifier} - ${linearIssue.title}`,
			);
			return linearIssue;
		} catch (error) {
			throw new Error(
				`Failed to create Linear issue from TestFlight feedback: ${error}`,
			);
		}
	}

	/** Fail closed if routing is unavailable; never silently fall back to Backlog. */
	public async validateDestination(projectId?: string, requireTriage = true): Promise<string | undefined> {
		if (requireTriage && !projectId) throw new Error("Linear project ID is required");
		if (projectId) {
			const project = await this.sdk.project(projectId);
			let teams = await project.teams();
			while (!teams.nodes.some(t => t.id === this.config.teamId) && teams.pageInfo.hasNextPage) {
				await teams.fetchNext();
			}
			if (!teams.nodes.some(t => t.id === this.config.teamId)) throw new Error("Project does not belong to the configured team");
		}
		if (!requireTriage) return undefined;
		const team = await this.sdk.team(this.config.teamId);
		if (!team.triageEnabled) throw new Error("Enable Triage for the configured team before importing");
		const triage = await team.triageIssueState;
		if (!triage || triage.type !== "triage") throw new Error("Triage state is unavailable");
		return triage.id;
	}

	/** Upload before issue creation; retry after failures without a partial issue. */
	private async preserveAssets(feedback: ProcessedFeedbackData): Promise<ProcessedFeedbackData> {
		const result = structuredClone(feedback);
		const upload = async (body: Blob, name: string): Promise<string> => {
			const payload = await this.sdk.fileUpload(body.type, name, body.size);
			if (!payload.success || !payload.uploadFile) throw new Error("Linear upload preparation failed");
			const file = payload.uploadFile;
			const headers = new Headers({ "Content-Type": body.type, "Cache-Control": "public, max-age=31536000" });
			file.headers.forEach(({ key, value }) => headers.set(key, value));
			const response = await fetch(file.uploadUrl, { method: "PUT", headers, body, signal: AbortSignal.timeout(60_000) });
			if (!response.ok) throw new Error(`Linear upload failed (${response.status})`);
			return file.assetUrl;
		};
		const download = async (url: string): Promise<Blob> => {
			const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (!response.ok) throw new Error(`Apple asset download failed (${response.status})`);
			return new Blob([await response.arrayBuffer()], { type: response.headers.get("Content-Type") || "application/octet-stream" });
		};
		if (result.screenshotData) {
			const images = result.screenshotData.enhancedImages?.length ? result.screenshotData.enhancedImages : result.screenshotData.images;
			result.screenshotData.images = await Promise.all(images.map(async image => ({
				...image, url: await upload(await download(image.url), image.fileName),
			})));
		}
		if (result.crashData) {
			const logs = result.crashData.detailedLogs || [];
			for (let index = 0; index < logs.length; index++) {
				const url = await upload(new Blob([logs[index]!], { type: "text/plain" }), `testflight-${feedback.id}-${index + 1}.ips`);
				result.crashData.logs.push({ url, expiresAt: new Date(0) });
			}
			for (const log of result.crashData.logs.slice(0, result.crashData.logs.length - logs.length)) {
				log.url = await upload(await download(log.url), `testflight-${feedback.id}.ips`);
			}
		}
		return result;
	}

	/**
	 * Updates an existing Linear issue status
	 */
	public async updateIssueStatus(
		issueId: string,
		statusName: string,
	): Promise<LinearIssue> {
		try {
			const status = await this.getIssueStatusByName(statusName);

			const updatePayload = await this.sdk.updateIssue(issueId, {
				stateId: status.id,
			});

			if (!updatePayload.success) {
				throw new Error("Linear API error: Failed to update issue");
			}

			const updatedIssue = await updatePayload.issue;
			if (!updatedIssue) {
				throw new Error("Failed to retrieve updated issue from Linear");
			}

			return await this.convertToLinearIssue(updatedIssue);
		} catch (error) {
			throw new Error(`Failed to update Linear issue status: ${error}`);
		}
	}

	/**
	 * Adds a comment to an existing Linear issue
	 */
	public async addCommentToIssue(
		issueId: string,
		body: string,
	): Promise<LinearComment> {
		try {
			const commentPayload = await this.sdk.createComment({
				issueId,
				body,
			});

			if (!commentPayload.success) {
				throw new Error("Linear API error: Failed to create comment");
			}

			const comment = await commentPayload.comment;
			if (!comment) {
				throw new Error("Failed to retrieve created comment from Linear");
			}

			const issueBasic = await comment.issue;
			const team = await this.getTeam();

			// Create a minimal LinearIssue object for the comment
			const issueForComment: LinearIssue = issueBasic
				? await this.convertToLinearIssue(issueBasic)
				: {
					id: "unknown",
					identifier: "unknown",
					title: "Unknown Issue",
					description: "",
					url: "",
					priority: 3,
					state: {
						id: "unknown",
						name: "Unknown",
						description: "",
						color: "#000000",
						position: 0,
						type: "backlog",
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						team,
					},
					assignee: undefined,
					team,
					labels: [],
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					estimate: 0,
					sortOrder: 0,
					number: 0,
					creator: await this.createFallbackUser(),
					parent: undefined,
					children: [],
					relations: [],
					comments: [],
					attachments: [],
					project: undefined,
					cycle: undefined,
					previousIdentifiers: [],
					customerTicketCount: 0,
					subscribers: [],
				};

			return {
				id: comment.id,
				body: comment.body,
				user: await this.convertToLinearUser(comment.user),
				issue: issueForComment,
				url: issueBasic ? `${issueBasic.url}#comment-${comment.id}` : "",
				createdAt: comment.createdAt.toISOString(),
				updatedAt: comment.updatedAt.toISOString(),
			};
		} catch (error) {
			throw new Error(`Failed to add comment to Linear issue: ${error}`);
		}
	}

	/**
	 * Searches for duplicate issues in Linear
	 */
	public async findDuplicateIssue(
		feedback: ProcessedFeedbackData,
	): Promise<LinearIssue | null> {
		// Match both upstream table descriptions and the older plain-text form.
		// Include archived issues so closing/archiving never reimports feedback.
		let after: string | undefined;
		do {
			const issues = await this.sdk.issues({
				filter: { team: { id: { eq: this.config.teamId } }, description: { contains: feedback.id } },
				includeArchived: true, first: 100, after,
			});
			for (const issue of issues.nodes) {
				const description = (await issue.description) || "";
				if (description.includes(`| **TestFlight ID** | \`${feedback.id}\` |`) ||
					description.split("\n").some(line => line.trim() === `TestFlight ID: ${feedback.id}`)) {
					return await this.convertToLinearIssue(issue);
				}
			}
			after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : undefined;
		} while (after);
		return null;
	}

	/**
	 * Gets the configured team information
	 */
	public async getTeam(): Promise<LinearTeam> {
		if (this.teamCache) {
			return this.teamCache;
		}

		try {
			const team = await this.sdk.team(this.config.teamId);

			this.teamCache = await this.convertToLinearTeam(team);
			return this.teamCache;
		} catch (error) {
			throw new Error(`Failed to get Linear team: ${error}`);
		}
	}

	/**
	 * Gets the configured team ID for health checking
	 */
	public getConfiguredTeamId(): string {
		return this.config.teamId;
	}

	/**
	 * Tests basic Linear connectivity without full team validation
	 * Used by health checkers for lightweight connectivity testing
	 */
	public async testConnectivity(): Promise<boolean> {
		try {
			await this.getCurrentUser();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Gets available issue statuses for the team
	 */
	public async getIssueStatuses(): Promise<LinearIssueStatus[]> {
		try {
			const states = await this.sdk.workflowStates({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
			});

			const statuses: LinearIssueStatus[] = [];
			for (const state of states.nodes) {
				statuses.push(await this.convertToLinearIssueStatus(state));
			}

			return statuses;
		} catch (error) {
			throw new Error(`Failed to get Linear issue statuses: ${error}`);
		}
	}

	/**
	 * Gets a specific issue status by name
	 */
	public async getIssueStatusByName(
		statusName: string,
	): Promise<LinearIssueStatus> {
		try {
			const states = await this.sdk.workflowStates({
				filter: {
					team: { id: { eq: this.config.teamId } },
					name: { eq: statusName },
				},
			});

			if (states.nodes.length === 0) {
				throw new Error(`Issue status '${statusName}' not found`);
			}

			return await this.convertToLinearIssueStatus(states.nodes[0]);
		} catch (error) {
			throw new Error(`Failed to get Linear issue status: ${error}`);
		}
	}

	/**
	 * Gets available issue labels for the team
	 */
	public async getIssueLabels(): Promise<LinearIssueLabel[]> {
		try {
			const labels = await this.sdk.issueLabels({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
			});

			const issueLabels: LinearIssueLabel[] = [];
			for (const label of labels.nodes) {
				issueLabels.push(await this.convertToLinearIssueLabel(label));
			}

			return issueLabels;
		} catch (error) {
			throw new Error(`Failed to get Linear issue labels: ${error}`);
		}
	}

	/**
	 * Gets recent issues from Linear
	 */
	public async getRecentIssues(limit = 20): Promise<LinearIssue[]> {
		try {
			const issues = await this.sdk.issues({
				filter: {
					team: { id: { eq: this.config.teamId } },
				},
				first: limit,
			});

			const linearIssues: LinearIssue[] = [];
			for (const issue of issues.nodes) {
				linearIssues.push(await this.convertToLinearIssue(issue));
			}

			return linearIssues;
		} catch (error) {
			throw new Error(`Failed to get recent Linear issues: ${error}`);
		}
	}

	/**
	 * Gets projects from Linear
	 */
	public async getProjects(): Promise<LinearProject[]> {
		try {
			const projects = await this.sdk.projects();

			const linearProjects: LinearProject[] = [];
			for (const project of projects.nodes) {
				linearProjects.push(await this.convertToLinearProject(project));
			}

			return linearProjects;
		} catch (error) {
			throw new Error(`Failed to get Linear projects: ${error}`);
		}
	}

	/**
	 * Gets current user information
	 */
	public async getCurrentUser(): Promise<LinearUser> {
		try {
			const viewer = await this.sdk.viewer;
			return await this.convertToLinearUser(viewer);
		} catch (error) {
			throw new Error(`Failed to get current Linear user: ${error}`);
		}
	}

	/**
	 * Health check for Linear integration
	 */
	public async healthCheck(): Promise<{
		status: "healthy" | "unhealthy";
		details: {
			teamName?: string;
			teamKey?: string;
			currentUser?: string;
			configuredTeamId?: string;
			error?: string;
			timestamp: string;
		};
	}> {
		try {
			// Test basic connectivity
			const [team, user] = await Promise.all([
				this.getTeam(),
				this.getCurrentUser(),
			]);

			return {
				status: "healthy",
				details: {
					teamName: team.name,
					teamKey: team.key,
					currentUser: user.name,
					configuredTeamId: this.config.teamId,
					timestamp: new Date().toISOString(),
				},
			};
		} catch (error) {
			return {
				status: "unhealthy",
				details: {
					error: (error as Error).message,
					configuredTeamId: this.config.teamId,
					timestamp: new Date().toISOString(),
				},
			};
		}
	}

	/**
	 * Helper method to convert Linear SDK issue to our LinearIssue interface
	 */
	private async convertToLinearIssue(issue: any): Promise<LinearIssue> {
		const team = await this.getTeam();
		const state = await issue.state;
		const assignee = await issue.assignee;
		const creator = await issue.creator;

		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			description: (await issue.description) || "",
			url: issue.url,
			priority: this.mapLinearPriorityToPriority(issue.priority),
			state: await this.convertToLinearIssueStatus(state),
			assignee: assignee ? await this.convertToLinearUser(assignee) : undefined,
			team,
			labels: [],
			createdAt: issue.createdAt.toISOString(),
			updatedAt: issue.updatedAt.toISOString(),
			estimate: issue.estimate || 0,
			sortOrder: issue.sortOrder || 0,
			number: issue.number,
			dueDate: issue.dueDate?.toISOString(),
			completedAt: issue.completedAt?.toISOString(),
			canceledAt: issue.canceledAt?.toISOString(),
			autoClosedAt: issue.autoClosedAt?.toISOString(),
			autoArchivedAt: issue.autoArchivedAt?.toISOString(),
			archivedAt: issue.archivedAt?.toISOString(),
			creator: creator
				? await this.convertToLinearUser(creator)
				: await this.createFallbackUser(),
			parent: undefined,
			children: [],
			relations: [],
			comments: [],
			attachments: [],
			project: undefined,
			cycle: undefined,
			previousIdentifiers: [],
			customerTicketCount: 0,
			subscribers: [],
		};
	}

	/**
	 * Creates a fallback user when no creator is available
	 */
	private async createFallbackUser(): Promise<LinearUser> {
		return {
			id: "unknown",
			name: "Unknown User",
			displayName: "Unknown User",
			email: "",
			avatarUrl: undefined,
			isMe: false,
			isAdmin: false,
			isGuest: true,
			active: false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK user to our LinearUser interface
	 */
	private async convertToLinearUser(user: any): Promise<LinearUser> {
		return {
			id: user.id,
			name: user.name,
			displayName: user.displayName || user.name,
			email: user.email,
			avatarUrl: user.avatarUrl,
			isMe: user.isMe || false,
			isAdmin: user.admin || false,
			isGuest: user.guest || false,
			active: user.active || true,
			createdAt: user.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: user.updatedAt?.toISOString() || new Date().toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK team to our LinearTeam interface
	 */
	private async convertToLinearTeam(team: any): Promise<LinearTeam> {
		return {
			id: team.id,
			name: team.name,
			key: team.key,
			description: (await team.description) || "",
			icon: team.icon,
			color: team.color,
			private: team.private || false,
			autoArchivePeriod: team.autoArchivePeriod || 0,
			autoCloseParentIssues: team.autoCloseParentIssues || false,
			cyclesEnabled: team.cyclesEnabled || false,
			cycleStartDay: team.cycleStartDay || 0,
			cycleDuration: team.cycleDuration || 1,
			cycleCooldownTime: team.cycleCooldownTime || 0,
			upcomingCycleCount: team.upcomingCycleCount || 0,
			timezone: team.timezone || "UTC",
			inviteHash: team.inviteHash || "",
			issueEstimationType: team.issueEstimationType || "notUsed",
			issueEstimationAllowZero: team.issueEstimationAllowZero || false,
			issueEstimationExtended: team.issueEstimationExtended || false,
			issueOrderingNoPriorityFirst: team.issueOrderingNoPriorityFirst || false,
			issueSortOrderDefaultToBottom:
				team.issueSortOrderDefaultToBottom || false,
			defaultIssueEstimate: team.defaultIssueEstimate,
			defaultTemplateForMembersId: team.defaultTemplateForMembersId,
			defaultTemplateForNonMembersId: team.defaultTemplateForNonMembersId,
			triageEnabled: team.triageEnabled || false,
			requirePriorityToLeaveTriage: team.requirePriorityToLeaveTriage || false,
			createdAt: team.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: team.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: team.archivedAt?.toISOString(),
		};
	}

	/**
	 * Helper method to convert Linear SDK state to our LinearIssueStatus interface
	 */
	private async convertToLinearIssueStatus(
		state: any,
	): Promise<LinearIssueStatus> {
		const team = await this.getTeam();

		return {
			id: state.id,
			name: state.name,
			description: state.description,
			color: state.color,
			position: state.position || 0,
			type: this.mapStateTypeToLinearIssueState(state.type),
			createdAt: state.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: state.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: state.archivedAt?.toISOString(),
			team,
		};
	}

	/**
	 * Helper method to convert Linear SDK label to our LinearIssueLabel interface
	 */
	private async convertToLinearIssueLabel(
		label: any,
	): Promise<LinearIssueLabel> {
		const team = await this.getTeam();

		return {
			id: label.id,
			name: label.name,
			color: label.color,
			description: (await label.description) || "",
			parent: undefined,
			children: [],
			createdAt: label.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: label.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: label.archivedAt?.toISOString(),
			creator: await this.createFallbackUser(),
			team,
		};
	}

	/**
	 * Helper method to convert Linear SDK project to our LinearProject interface
	 */
	private async convertToLinearProject(project: any): Promise<LinearProject> {
		return {
			id: project.id,
			name: project.name,
			description: (await project.description) || "",
			slug: project.slug || project.name.toLowerCase().replace(/\s+/g, "-"),
			icon: project.icon,
			color: project.color,
			state: project.state || "planned",
			content: await project.content,
			priority: this.mapLinearPriorityToPriority(project.priority) as any,
			sortOrder: project.sortOrder || 0,
			startDate: project.startDate?.toISOString(),
			targetDate: project.targetDate?.toISOString(),
			completedAt: project.completedAt?.toISOString(),
			canceledAt: project.canceledAt?.toISOString(),
			autoArchivedAt: project.autoArchivedAt?.toISOString(),
			createdAt: project.createdAt?.toISOString() || new Date().toISOString(),
			updatedAt: project.updatedAt?.toISOString() || new Date().toISOString(),
			archivedAt: project.archivedAt?.toISOString(),
			creator: await this.convertToLinearUser(await project.creator),
			lead: undefined,
			members: [],
			teams: [],
			milestones: [],
			documents: [],
			links: [],
			requirements: [],
			roadmaps: [],
		};
	}

	/**
	 * Prepares Linear issue data from TestFlight feedback
	 */
	private prepareIssueFromTestFlight(
		feedback: ProcessedFeedbackData,
		additionalLabels: string[] = [],
		assigneeId?: string,
		projectId?: string,
		options?: {
			customTitle?: string;
			customDescription?: string;
			priority?: LinearPriority;
			requireTriage?: boolean;
		},
	) {
		const isCrash = feedback.type === "crash";
		const typeIcon = isCrash ? "💥" : "📱";
		const typeLabel = isCrash ? "Crash Report" : "User Feedback";

		// Generate title - use enhanced title if provided, otherwise generate standard title
		let title = options?.customTitle ||
			`${typeIcon} ${typeLabel}: ${feedback.appVersion} (${feedback.buildNumber})`;

		// If using standard title, add additional context
		if (!options?.customTitle) {
			if (isCrash && feedback.crashData?.exceptionType) {
				title += ` - ${feedback.crashData.exceptionType}`;
			} else if (feedback.screenshotData?.text) {
				const shortText = feedback.screenshotData.text.substring(0, 40);
				title += ` - ${shortText}${shortText.length < feedback.screenshotData.text.length ? "..." : ""}`;
			}
		}

		// Generate description - use enhanced description if provided, otherwise generate standard description
		const description = options?.customDescription ||
			this.generateStandardDescription(feedback, typeIcon, typeLabel);

		// Determine labels
		const baseLabels = isCrash
			? this.config.crashLabels
			: this.config.feedbackLabels;
		const allLabels = [
			...this.config.defaultLabels,
			...baseLabels,
			...additionalLabels,
		];

		// Determine priority - use enhanced priority if provided, otherwise use default logic
		let priority = options?.priority || this.config.defaultPriority;
		if (!options?.priority && isCrash) {
			priority = 2; // High priority for crashes when not using enhanced priority
		}

		return {
			title,
			description,
			teamId: this.config.teamId,
			priority,
			assigneeId,
			projectId,
			labels: allLabels,
		};
	}

	/**
	 * Generates standard description for Linear issues from TestFlight feedback
	 */
	private generateStandardDescription(
		feedback: ProcessedFeedbackData,
		typeIcon: string,
		typeLabel: string,
	): string {
		const isCrash = feedback.type === "crash";

		// Start with header
		let description = `## ${typeIcon} ${typeLabel} from TestFlight\n\n`;

		// Metadata table
		description += "| Field | Value |\n";
		description += "|-------|-------|\n";
		description += `| **TestFlight ID** | \`${feedback.id}\` |\n`;
		description += `| **App Version** | ${feedback.appVersion} (Build ${feedback.buildNumber}) |\n`;
		description += `| **Submitted** | ${feedback.submittedAt.toISOString()} |\n`;
		description += `| **Device** | ${feedback.deviceInfo.model} |\n`;
		description += `| **OS Version** | ${feedback.deviceInfo.osVersion} |\n`;
		description += `| **Locale** | ${feedback.deviceInfo.locale} |\n\n`;

		if (isCrash && feedback.crashData) {
			description += "### 🔍 Crash Details\n\n";
			description += `**Type:** ${feedback.crashData.type}\n\n`;

			if (feedback.crashData.exceptionType) {
				description += `**Exception:** \`${feedback.crashData.exceptionType}\`\n\n`;
			}

			if (feedback.crashData.exceptionMessage) {
				description += `**Message:**\n\`\`\`\n${feedback.crashData.exceptionMessage}\n\`\`\`\n\n`;
			}

			// ENHANCEMENT: Add system context for better debugging
			if (feedback.crashData.systemInfo) {
				description += "### 📊 System Context at Crash\n\n";
				const sysInfo = feedback.crashData.systemInfo;

				description += "| Context | Value |\n";
				description += "|---------|-------|\n";

				if (sysInfo.batteryPercentage !== undefined) {
					const batteryIcon = sysInfo.batteryPercentage < 20 ? "🪫" : sysInfo.batteryPercentage < 50 ? "🔋" : "🔋";
					description += `| ${batteryIcon} **Battery** | ${sysInfo.batteryPercentage}% |\n`;
				}

				if (sysInfo.appUptimeFormatted) {
					description += `| ⏱️ **App Uptime** | ${sysInfo.appUptimeFormatted} |\n`;
				}

				if (sysInfo.connectionType) {
					const connectionIcon = sysInfo.connectionType.toLowerCase().includes('wifi') ? "📶" : "📱";
					description += `| ${connectionIcon} **Connection** | ${sysInfo.connectionType} |\n`;
				}

				if (sysInfo.diskSpaceRemainingGB !== null && sysInfo.diskSpaceRemainingGB !== undefined) {
					const spaceIcon = sysInfo.diskSpaceRemainingGB < 1 ? "💾" : "💿";
					description += `| ${spaceIcon} **Free Space** | ${sysInfo.diskSpaceRemainingGB}GB |\n`;
				}

				if (sysInfo.architecture) {
					description += `| 🏗️ **Architecture** | ${sysInfo.architecture} |\n`;
				}

				if (sysInfo.pairedAppleWatch) {
					description += `| ⌚ **Apple Watch** | ${sysInfo.pairedAppleWatch} |\n`;
				}

				description += "\n";
			}

			description += `### Stack Trace\n\`\`\`\n${feedback.crashData.trace}\n\`\`\`\n\n`;

			if (feedback.crashData.logs.length > 0) {
				description += "### Crash Logs\n";
				feedback.crashData.logs.forEach((log, index) => {
					description += `- [Crash Log ${index + 1}](${log.url}) \n`;
				});
				description += "\n";
			}
		}

		if (feedback.screenshotData) {
			description += "### 📝 User Feedback\n\n";

			if (feedback.screenshotData.text) {
				description += `**Feedback Text:**\n> ${feedback.screenshotData.text.replace(/\n/g, "\n> ")}\n\n`;
			}

			// Show enhanced tester notes if available
			if (feedback.screenshotData.testerNotes) {
				description += `**Tester Notes:**\n> ${feedback.screenshotData.testerNotes.replace(/\n/g, "\n> ")}\n\n`;
			}

			if (feedback.screenshotData.images.length > 0) {
				description += feedback.screenshotData.images.map((image, index) => `![TestFlight screenshot ${index + 1}](${image.url})`).join("\n\n");

				// Add enhanced screenshot info if available
				if (feedback.screenshotData.enhancedImages && feedback.screenshotData.enhancedImages.length > 0) {
					const enhancedCount = feedback.screenshotData.enhancedImages.length;
					description += ` (${enhancedCount} with enhanced metadata)`;
				}

				description += "\n\n";
			}

			if (
				feedback.screenshotData.annotations &&
				feedback.screenshotData.annotations.length > 0
			) {
				description += `**Annotations:** ${feedback.screenshotData.annotations.length} user annotation(s)\n\n`;
			}

			// Add submission method and system info if available
			if (feedback.screenshotData.submissionMethod) {
				description += `**Submission Method:** ${feedback.screenshotData.submissionMethod}\n\n`;
			}

			if (feedback.screenshotData.systemInfo) {
				description += this.formatSystemInfo(feedback.screenshotData.systemInfo);
			}
		}

		// Technical details
		description += "### 🛠️ Technical Information\n\n";
		description +=
			"<details>\n<summary>Device & Environment Details</summary>\n\n";
		description += `- **Device Family:** ${feedback.deviceInfo.family}\n`;
		description += `- **Device Model:** ${feedback.deviceInfo.model}\n`;
		description += `- **OS Version:** ${feedback.deviceInfo.osVersion}\n`;
		description += `- **Locale:** ${feedback.deviceInfo.locale}\n`;
		description += `- **Bundle ID:** ${feedback.bundleId}\n`;
		description += `- **Submission Time:** ${feedback.submittedAt.toISOString()}\n`;
		description += "\n</details>\n\n";

		description += `---\n*Automatically created from TestFlight feedback. ID: \`${feedback.id}\`*`;

		return description;
	}

	/**
	 * Adds a TestFlight-specific comment to an existing issue
	 */
	private async addTestFlightCommentToIssue(
		issueId: string,
		feedback: ProcessedFeedbackData,
	): Promise<LinearComment> {
		const typeIcon = feedback.type === "crash" ? "💥" : "📱";

		let commentBody = `${typeIcon} **Additional TestFlight ${feedback.type} report**\n\n`;
		commentBody += `**TestFlight ID:** ${feedback.id}\n`;
		commentBody += `**Submitted:** ${feedback.submittedAt.toISOString()}\n`;
		commentBody += `**Device:** ${feedback.deviceInfo.model} (${feedback.deviceInfo.osVersion})\n`;

		if (feedback.screenshotData?.text) {
			commentBody += `\n**User Feedback:**\n> ${feedback.screenshotData.text}`;
		}

		return await this.addCommentToIssue(issueId, commentBody);
	}

	/**
	 * Maps our priority enum to Linear's priority number
	 */
	private mapPriorityToLinearPriority(
		priority: LinearPriority | number,
	): number {
		if (typeof priority === "number") {
			return priority;
		}

		switch (priority) {
			case 1:
				return 1; // Urgent
			case 2:
				return 2; // High
			case 3:
				return 3; // Normal
			case 4:
				return 4; // Low
			default:
				return 3; // Normal
		}
	}

	/**
	 * Maps Linear's priority number to our priority enum
	 */
	private mapLinearPriorityToPriority(priority?: number): LinearPriority {
		switch (priority) {
			case 1:
				return 1; // Urgent
			case 2:
				return 2; // High
			case 3:
				return 3; // Normal
			case 4:
				return 4; // Low
			default:
				return 3; // Normal
		}
	}

	/**
	 * Maps Linear state type to our issue state enum
	 */
	private mapStateTypeToLinearIssueState(
		stateType: string,
	): "backlog" | "unstarted" | "started" | "completed" | "canceled" {
		switch (stateType) {
			case "backlog":
				return "backlog";
			case "unstarted":
				return "unstarted";
			case "started":
				return "started";
			case "completed":
				return "completed";
			case "canceled":
				return "canceled";
			default:
				return "backlog";
		}
	}

	/**
	 * Formats enhanced system information for display (DRY helper)
	 */
	private formatSystemInfo(systemInfo: any): string {
		if (!systemInfo) {
			return "";
		}

		let info = "**System Information:**\n";

		if (systemInfo.applicationState) {
			info += `- Application State: ${systemInfo.applicationState}\n`;
		}

		if (systemInfo.memoryPressure) {
			info += `- Memory Pressure: ${systemInfo.memoryPressure}\n`;
		}

		if (systemInfo.batteryLevel !== undefined) {
			info += `- Battery Level: ${(systemInfo.batteryLevel * 100).toFixed(0)}%\n`;
		}

		if (systemInfo.batteryState) {
			info += `- Battery State: ${systemInfo.batteryState}\n`;
		}

		if (systemInfo.thermalState) {
			info += `- Thermal State: ${systemInfo.thermalState}\n`;
		}

		if (systemInfo.diskSpaceRemaining !== undefined) {
			const diskSpaceGB = (systemInfo.diskSpaceRemaining / (1024 * 1024 * 1024)).toFixed(1);
			info += `- Available Storage: ${diskSpaceGB} GB\n`;
		}

		return info + "\n";
	}
}

// Global Linear client instance
let _linearClientInstance: LinearClient | null = null;

export function getLinearClient(): LinearClient {
	if (!_linearClientInstance) {
		_linearClientInstance = new LinearClient();
	}
	return _linearClientInstance;
}

/**
 * Clears the global Linear client instance (useful for testing)
 */
export function clearLinearClientInstance(): void {
	_linearClientInstance = null;
}

/**
 * Utility function to validate Linear configuration
 */
export function validateLinearConfig(): boolean {
	try {
		const config = getConfiguration();
		return !!(config.linear?.apiToken && config.linear?.teamId);
	} catch {
		return false;
	}
}
