import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "../../../src/gateway/control-ui-contract.js";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same worktree-session extras (PR link, checkout path) when opening the
// session context menu, after the menu is already visible.
export type SessionMenuWorkClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
};

export type SessionMenuWorkParams = {
  client: SessionMenuWorkClient;
  /** controlUi.sessionPullRequests is optional gateway surface; skip when absent. */
  pullRequestsAvailable: boolean;
  sessionKey: string;
  agentId?: string;
  worktreeId?: string;
};

export type SessionMenuWorkResult = {
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

// Menu offers a single Open PR action; prefer the PR a maintainer most
// likely wants: active first, merged history next, closed last.
const PR_STATE_ORDER: ReadonlyArray<ControlUiSessionPullRequest["state"]> = [
  "open",
  "draft",
  "merged",
  "closed",
];

export function pickSessionMenuPullRequestUrl(
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

async function loadPullRequestUrl(params: SessionMenuWorkParams): Promise<string | null> {
  if (!params.pullRequestsAvailable) {
    return null;
  }
  try {
    const result = await params.client.request<ControlUiSessionPullRequests>(
      "controlUi.sessionPullRequests",
      { sessionKey: params.sessionKey, ...(params.agentId ? { agentId: params.agentId } : {}) },
    );
    return pickSessionMenuPullRequestUrl(result.pullRequests);
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
