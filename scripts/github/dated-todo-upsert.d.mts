export function validateDatedTodoReport(
  report: string,
  options?: { expectedDate?: string; repoRoot?: string },
): void;

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
