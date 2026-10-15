import { describe, test, expect } from 'bun:test';
import { LinearClient } from '../src/api/linear-client';
const feedback: any = { id: 'feedback-123', type: 'screenshot', bundleId: 'com.example.app', appVersion: '1.0', buildNumber: '42', submittedAt: new Date('2026-10-15T12:00:00Z'), deviceInfo: { model: 'iPhone', osVersion: '26', locale: 'en', family: 'iPhone' }, screenshotData: { text: 'original\nfeedback', images: [] } };
function client(sdk: any = {}) {
 const c: any = Object.create(LinearClient.prototype);
 c.config = { teamId: 'team', enableDuplicateDetection: true, defaultPriority: 3, defaultLabels: [], crashLabels: [], feedbackLabels: [] };
 c.sdk = sdk;
 c.convertToLinearIssue = async (issue: any) => issue;
 return c;
}
describe('TestFlight PM Linear regression', () => {
 test('finds its own standard description, including archived issues', async () => {
  const c = client();
  const description = c.generateStandardDescription(feedback, '', 'Feedback');
  c.sdk.issues = async (args: any) => {
   expect(args.includeArchived).toBe(true);
   const search = args.filter.or?.[1]?.description?.containsIgnoreCase ?? args.filter.description?.contains;
   return { nodes: description.includes(search) ? [{ id: 'existing', description }] : [], pageInfo: { hasNextPage: false } };
  };
  expect((await c.findDuplicateIssue(feedback))?.id).toBe('existing');
 });
 test('repeated feedback does not create a comment or issue', async () => {
  const c = client({ createComment: () => { throw Error('comment spam'); }, createIssue: () => { throw Error('duplicate issue'); } });
  c.findDuplicateIssue = async () => ({ id: 'existing' });
  expect((await c.createIssueFromTestFlight(feedback)).id).toBe('existing');
 });
 test('search failure stops creation', async () => {
  const c = client({ issues: async () => { throw Error('offline'); } });
  await expect(c.findDuplicateIssue(feedback)).rejects.toThrow('offline');
 });
});

import { importFeedback } from './run';
const destination = { bundleId: 'com.example.app', teamId: 'team', projectId: 'project', requireTriage: true };
import { TestFlightClient } from '../src/api/testflight-client';

test('dry run and repeat runs never write; real import routes to project', async () => {
 let calls = 0;
 const existing = new Set();
 const linear = {
  findDuplicateIssue: async (f: any) => existing.has(f.id) ? { id: f.id } : null,
  createIssueFromTestFlight: async (f: any, labels: any, assignee: any, project: string) => {
   expect(project).toBe(destination.projectId); calls++; existing.add(f.id);
  },
 };
 expect((await importFeedback([structuredClone(feedback)], linear as any, true, destination)).preview).toBe(1);
 expect(calls).toBe(0);
 expect((await importFeedback([structuredClone(feedback)], linear as any, false, destination)).created).toBe(1);
 expect((await importFeedback([structuredClone(feedback)], linear as any, false, destination)).skipped).toBe(1);
 expect(calls).toBe(1);
});

test('new issue requires team Triage and matching project; uses explicit state', async () => {
 let data: any;
 const c = client({
  issues: async () => ({ nodes: [], pageInfo: {} }),
  team: async () => ({ triageEnabled: true, triageIssueState: { id: 'triage', type: 'triage' } }),
  project: async () => ({ teams: async () => ({ nodes: [{ id: 'team' }] }) }),
  createIssue: async (input: any) => { data = input; return { success: true, issue: { id: 'new' } }; },
 });
 await c.createIssueFromTestFlight(feedback, [], undefined, 'project', { requireTriage: true });
 expect(data.teamId).toBe('team'); expect(data.projectId).toBe('project'); expect(data.stateId).toBe('triage');
 expect(data.description).toContain('original\n> feedback');
 c.sdk.team = async () => ({ triageEnabled: false });
 await expect(c.validateDestination('project')).rejects.toThrow('Enable Triage');
 c.sdk.team = async () => ({ triageEnabled: true, triageIssueState: { id: 'triage', type: 'triage' } });
 c.sdk.project = async () => ({ teams: async () => ({ nodes: [], pageInfo: { hasNextPage: false } }) });
 await expect(c.validateDestination('wrong')).rejects.toThrow('Project does not belong');
});

test('uploads actual screenshots and detailed crash logs before issue creation', async () => {
 const originalFetch = globalThis.fetch;
 const uploaded: string[] = [];
 let data: any;
 try {
  globalThis.fetch = (async (url: string, options: any) => {
   if (options?.method === 'PUT') uploaded.push(await options.body.text());
   return new Response('image bytes', { headers: { 'Content-Type': 'image/png' } });
  }) as any;
  const c = client({
   issues: async () => ({ nodes: [], pageInfo: {} }),
   team: async () => ({ triageEnabled: true, triageIssueState: { id: 'triage', type: 'triage' } }),
   project: async () => ({ teams: async () => ({ nodes: [{ id: 'team' }] }) }),
   fileUpload: async (_type: string, name: string) => ({ success: true, uploadFile: { uploadUrl: 'https://upload.test', assetUrl: `https://linear-assets.test/${name}`, headers: [] } }),
   createIssue: async (input: any) => { data = input; return { success: true, issue: { id: 'new' } }; },
  });
  const f = structuredClone(feedback);
  f.type = 'crash';
  f.screenshotData.images = [{ url: 'https://apple.test/expiring.png', fileName: 'screen.png' }];
  f.crashData = { trace: 'stack', type: 'crash', logs: [], detailedLogs: ['full original crash log'] };
  await c.createIssueFromTestFlight(f, [], undefined, 'project', { requireTriage: true });
  expect(uploaded).toEqual(['image bytes', 'full original crash log']);
  expect(data.description).toContain('![TestFlight screenshot 1](https://linear-assets.test/screen.png)');
  expect(data.description).toContain('https://linear-assets.test/testflight-feedback-123-1.ips');
  expect(data.description).not.toContain('expiring.png');
  globalThis.fetch = (async () => new Response('failed', { status: 403 })) as any;
  await expect(c.createIssueFromTestFlight(f, [], undefined, 'project', { requireTriage: true })).rejects.toThrow('download failed');
 } finally { globalThis.fetch = originalFetch; }
});

test('Apple feedback pagination retains every page and original crash comment', async () => {
 const apple: any = Object.create(TestFlightClient.prototype);
 apple.makeApiRequest = async (url: string) => url === 'https://apple.test/page2' ? { data: [{ id: 'second' }], links: {} } : { data: [{ id: 'first' }], links: { next: 'https://apple.test/page2' } };
 expect((await apple.getAppScreenshotSubmissions('app')).map((f: any) => f.id)).toEqual(['first', 'second']);
 expect((await apple.getAppCrashSubmissions('app')).map((f: any) => f.id)).toEqual(['first', 'second']);
 const f = apple.processCrashReport({ id: 'crash', attributes: { createdDate: '2026-10-15', comment: 'original crash feedback' } });
 expect(f.screenshotData.text).toBe('original crash feedback');
});

test('related Apple build supplies marketing version and build number', async () => {
 const apple: any = Object.create(TestFlightClient.prototype);
 apple.makeApiRequest = async () => ({ data: { attributes: { version: '42' } }, included: [{ type: 'preReleaseVersions', attributes: { version: '1.0' } }] });
 const raw: any = { attributes: {}, relationships: { build: { data: { id: 'build' } } } };
 await apple.hydrateBuild(raw);
 expect(raw.attributes).toEqual({ appVersion: '1.0', buildNumber: '42' });
});

test('optional triage preserves the original client default-status behavior', async () => {
 let input: any;
 const c = client({
  issues: async () => ({ nodes: [], pageInfo: {} }),
  createIssue: async (data: any) => { input = data; return { success: true, issue: { id: 'new' } }; },
 });
 await c.createIssueFromTestFlight(feedback);
 expect(input.stateId).toBeUndefined();
 expect(input.projectId).toBeUndefined();
});

test('duplicate lookup paginates and does not match another report ID', async () => {
 const c = client();
 const description = c.generateStandardDescription(feedback, '', 'Feedback');
 c.sdk.issues = async (args: any) => args.after ? {
  nodes: [{ id: 'match', description }], pageInfo: { hasNextPage: false },
 } : {
  nodes: [{ id: 'wrong', description: description.replaceAll('feedback-123', 'feedback-1234') }],
  pageInfo: { hasNextPage: true, endCursor: 'next' },
 };
 expect((await c.findDuplicateIssue(feedback)).id).toBe('match');
});
