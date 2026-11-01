export const BUILD_CONSENT = 'Build/refresh knowledge authorizes paid model processing for the selected repositories under the existing provider approvals and shared job limits. Eligible material elsewhere in designated folders may be consulted for relevant references. Static analysis is not runtime tracing; coverage is bounded, not exhaustive.';

export interface BuildRepository {
  name: string;
  path: string;
  root: string;
  documentationRoots: string[];
}
export interface BuildScope {
  repositories: BuildRepository[];
}
export interface BuildCoverage {
  repositories: string[];
  reusedRepositories: string[];
  reusedFrom: { repository: string; conversationId: string; messageId: string }[];
  inspected: { operation: 'list' | 'read' | 'search'; root: string; path: string; status: string }[];
  unsupported: { root: string; path: string; reason: string }[];
  failures: string[];
  unresolved: string[];
  truncated: boolean;
  notice: string;
}
