export function classifyPrForSweep(params: {
  pr: {
    draft?: boolean;
    created_at: string;
    updated_at: string;
    mergeable?: boolean | null;
    auto_merge?: object | null;
  };
  ciRuns: Array<{ conclusion: string | null }>;
  botCloseCount: number;
  now: number;
}): { action: "refire" | "skip"; reason: string };
export function classifyRunForRevive(params: {
  run: {
    conclusion: string | null;
    event: string;
    run_attempt: number;
    created_at: string;
    head_branch?: string | null;
    head_repository?: { full_name?: string };
  };
  prCreatedAt: string;
  prHeadBranch?: string;
  repoFullName?: string;
}): { action: "revive" | "skip"; reason: string };
export function runPrCiSweeper(params: {
  github: Record<string, unknown>;
  context: Record<string, unknown>;
  core: Pick<Console, "info"> & { setFailed: (message: string) => void };
  dryRun?: boolean;
  appSlug?: string;
  now?: number;
}): Promise<Array<{ number: number; sha: string; action: "refire" | "skip"; reason: string }>>;
