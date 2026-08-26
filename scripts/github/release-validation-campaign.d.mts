export type ReleaseValidationCampaignArtifact =
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "upsert";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
      releaseCommit: string;
      guidanceMainSha: string;
      title: string;
      body: string;
    }
  | {
      schema: "openclaw.release-validation-campaign/v1";
      operation: "close";
      tag: string;
      stableTrain: string;
      releaseUrl: string;
    };

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

/**
 * Structural subset of the Actions-provided Octokit client this publisher uses.
 * Declared locally so the script keeps a real contract without depending on
 * Octokit's generated types from a plain-Node script surface.
 */
export type ReleaseValidationCampaignGitHubClient = {
  rest: {
    issues: {
      get(params: Record<string, unknown>): Promise<{ data: unknown }>;
      getLabel(params: Record<string, unknown>): Promise<unknown>;
      createLabel(params: Record<string, unknown>): Promise<unknown>;
      createComment(params: Record<string, unknown>): Promise<unknown>;
      update(params: Record<string, unknown>): Promise<{ data: unknown }>;
      listForRepo: unknown;
    };
  };
  paginate(route: unknown, params: Record<string, unknown>): Promise<unknown[]>;
};

export function runReleaseValidationCampaignPublish(params: {
  github: ReleaseValidationCampaignGitHubClient;
  context: { repo: { owner: string; repo: string } };
  core: { info(message: string): void; setOutput?(name: string, value: string): void };
  artifact: unknown;
  expectedTag?: string;
  expectedReleaseCommit?: string;
  expectedGuidanceMainSha?: string;
  campaignIssueNumber?: number;
}): Promise<{
  action: "create" | "update" | "close" | "noop";
  issueNumber: number | undefined;
  issueUrl: string | undefined;
}>;
