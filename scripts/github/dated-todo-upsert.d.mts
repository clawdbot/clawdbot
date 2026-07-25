export function validateDatedTodoReport(
  report: string,
  options?: { expectedDate?: string; repoRoot?: string },
): void;

export function urgentKeys(text?: string | null): Set<string>;

export function selectTrackingIssue<
  T extends {
    number: number;
    state: string;
    body?: string | null;
    pull_request?: object;
    user?: { type?: string };
    labels?: Array<string | { name?: string | null }>;
  },
>(issues: T[]): T | undefined;

export function runDatedTodoUpsert(params: {
  github: Record<string, unknown>;
  context: { repo: { owner: string; repo: string } };
  core: { info: (message: string) => void; warning: (message: string) => void };
  dryRun?: boolean;
  report?: string;
}): Promise<{
  action: "create" | "update";
  issueNumber?: number;
  addedUrgent: string[];
}>;
