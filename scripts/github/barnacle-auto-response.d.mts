export const managedLabelSpecs: Record<string, { color: string; description: string }>;
export const candidateLabels: {
  blankTemplate: string;
  lowSignalDocs: string;
  docsDiscoverability: string;
  testOnlyNoBug: string;
  refactorOnly: string;
  needsPrContext: string;
  dirtyCandidate: string;
  riskyInfra: string;
  externalPluginCandidate: string;
};
export function classifyPullRequestCandidateLabels(
  pullRequest: Record<string, unknown>,
  files: Array<{ filename: string; status: string }>,
): string[];
export function runBarnacleAutoResponse(params: {
  github: Record<string, unknown>;
  context: Record<string, unknown>;
  core?: Pick<Console, "info">;
}): Promise<void>;
