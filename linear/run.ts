import { getTestFlightClient } from '../src/api/testflight-client';
import { getLinearClient } from '../src/api/linear-client';
import type { ProcessedFeedbackData } from '../types/testflight';

export interface Destination {
  bundleId: string;
  teamId: string;
  projectId: string;
  requireTriage: boolean;
}

// Linear is the durable record of imported feedback. No local cache can mark a
// failed or previewed submission processed. Serialize runs in the caller workflow.
export async function importFeedback(items: ProcessedFeedbackData[], linear: ReturnType<typeof getLinearClient>, dryRun: boolean, destination: Destination) {
  const counts = { created: 0, skipped: 0, preview: 0 };
  for (const feedback of items) {
    if (feedback.bundleId && feedback.bundleId !== destination.bundleId) throw Error('Unexpected Apple bundle ID');
    const original = { ...feedback, bundleId: destination.bundleId };
    if (await linear.findDuplicateIssue(original)) { counts.skipped++; continue; }
    if (dryRun) { counts.preview++; continue; }
    await linear.createIssueFromTestFlight(original, [], undefined, destination.projectId, { requireTriage: destination.requireTriage });
    counts.created++;
  }
  return counts;
}

if (import.meta.main) {
  try {
    for (const key of ['TESTFLIGHT_ISSUER_ID', 'TESTFLIGHT_KEY_ID', 'TESTFLIGHT_PRIVATE_KEY', 'LINEAR_API_TOKEN', 'TESTFLIGHT_BUNDLE_ID', 'LINEAR_TEAM_ID', 'LINEAR_PROJECT_ID']) {
      if (!process.env[key]) throw Error(`Missing configuration: ${key}`);
    }
    const destination: Destination = {
      bundleId: process.env.TESTFLIGHT_BUNDLE_ID!,
      teamId: process.env.LINEAR_TEAM_ID!,
      projectId: process.env.LINEAR_PROJECT_ID!,
      requireTriage: process.env.REQUIRE_TRIAGE !== 'false',
    };
    const dryRun = process.env.DRY_RUN !== 'false';
    const since = new Date(process.env.SINCE || Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(since.getTime()) || since > new Date()) throw Error('SINCE must be a valid past date');
    const linear = getLinearClient();
    await linear.validateDestination(destination.projectId, destination.requireTriage);
    const apple = getTestFlightClient();
    const items = await apple.getEnhancedRecentFeedback(since, destination.bundleId);
    const counts = await importFeedback(items, linear, dryRun, destination);
    console.log(JSON.stringify({ dryRun, since: since.toISOString(), ...counts }));
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(counts).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
  } catch {
    // API errors can include signed URLs or tester content. Keep the CI failure
    // summary free of raw responses, secrets, and private feedback.
    console.error('TestFlight import failed. Check credentials, Triage, project access, and service availability.');
    process.exitCode = 1;
  }
}
