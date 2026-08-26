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

type CampaignIssue = {
  number: number;
  state: string;
  title: string;
  body?: string | null;
  html_url: string;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: object;
};

type RepositoryParams = { owner: string; repo: string };

type CampaignIssueResponse = Promise<{ data: CampaignIssue }>;

type CampaignIssuesApi = {
  listForRepo(
    params: RepositoryParams & { state: "open"; labels: string; per_page: number },
  ): Promise<unknown>;
  getLabel(params: RepositoryParams & { name: string }): Promise<unknown>;
  createLabel(
    params: RepositoryParams & { name: string; color: string; description: string },
  ): Promise<unknown>;
  createComment(
    params: RepositoryParams & { issue_number: number; body: string },
  ): Promise<unknown>;
  create(
    params: RepositoryParams & { title: string; body: string; labels: string[] },
  ): CampaignIssueResponse;
  update(
    params: RepositoryParams & {
      issue_number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
      state_reason?: "completed";
      labels?: string[];
    },
  ): CampaignIssueResponse;
  get(params: RepositoryParams & { issue_number: number }): CampaignIssueResponse;
};

type CampaignGitHub = {
  paginate(
    method: CampaignIssuesApi["listForRepo"],
    params: Parameters<CampaignIssuesApi["listForRepo"]>[0],
  ): Promise<CampaignIssue[]>;
  rest: { issues: CampaignIssuesApi };
};

export function validateReleaseValidationCampaignArtifact(
  artifact: unknown,
  options?: {
    expectedTag?: string;
    expectedReleaseCommit?: string;
    expectedGuidanceMainSha?: string;
  },
): ReleaseValidationCampaignArtifact;

export function runReleaseValidationCampaignPublish(params: {
  github: CampaignGitHub;
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
