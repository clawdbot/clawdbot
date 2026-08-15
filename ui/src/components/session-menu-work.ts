import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same worktree-session extras (PR link, checkout path) when opening the
// session context menu, after the menu is already visible.
type SessionMenuWorkClient = Pick<GatewayBrowserClient, "request">;

type SessionMenuWorkParams = {
  client: SessionMenuWorkClient;
  /** Pushed session PR snapshots are optional; skip when the Gateway lacks them. */
  pullRequestsAvailable: boolean;
  sessionKey: string;
  agentId?: string;
  loadPullRequests?: () => Promise<ControlUiSessionPullRequestSnapshot | undefined>;
  worktreeId?: string;
};

type SessionMenuWorkResult = {
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

export type SessionPullRequestIndicatorState = "none" | "open" | "merged";

// Menu offers a single Open PR action; prefer the PR a maintainer most
// likely wants: active first, merged history next, closed last.
const PR_STATE_ORDER: ReadonlyArray<ControlUiSessionPullRequest["state"]> = [
  "open",
  "draft",
  "merged",
  "closed",
];

function pickSessionMenuPullRequestUrl(
  pullRequests: readonly ControlUiSessionPullRequest[],
): string | null {
  for (const state of PR_STATE_ORDER) {
    const match = pullRequests.find((pullRequest) => pullRequest.state === state);
    if (match) {
      return match.url;
    }
  }
  return null;
}

export function resolveSessionPullRequestIndicatorState(
  pullRequests: readonly ControlUiSessionPullRequest[],
): SessionPullRequestIndicatorState {
  if (
    pullRequests.some(
      (pullRequest) => pullRequest.state === "open" || pullRequest.state === "draft",
    )
  ) {
    return "open";
  }
  return pullRequests.some((pullRequest) => pullRequest.state === "merged") ? "merged" : "none";
}

async function loadPullRequestUrl(params: SessionMenuWorkParams): Promise<string | null> {
  if (!params.pullRequestsAvailable || !params.loadPullRequests) {
    return null;
  }
  try {
    const result = await params.loadPullRequests();
    return result ? pickSessionMenuPullRequestUrl(result.pullRequests) : null;
  } catch {
    // Optional affordance: a GitHub or gateway hiccup just leaves Open PR disabled.
    return null;
  }
}

async function loadWorktreePath(params: SessionMenuWorkParams): Promise<string | null> {
  const worktreeId = params.worktreeId;
  if (!worktreeId) {
    return null;
  }
  try {
    const result = await params.client.request<{ worktrees: WorktreeRecord[] }>(
      "worktrees.list",
      {},
    );
    const record = result.worktrees.find(
      (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
    );
    return record?.path ?? null;
  } catch {
    return null;
  }
}

export async function fetchSessionMenuWork(
  params: SessionMenuWorkParams,
): Promise<SessionMenuWorkResult> {
  const [pullRequestUrl, worktreePath] = await Promise.all([
    loadPullRequestUrl(params),
    loadWorktreePath(params),
  ]);
  return { pullRequestUrl, worktreePath };
}
