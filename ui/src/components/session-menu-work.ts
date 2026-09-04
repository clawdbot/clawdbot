import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isNativeLocalGateway } from "../app/native-editor-locality.runtime.ts";

// Shared by the app sidebar and the Sessions page: both hosts resolve the
// same worktree-session extras (PR link, checkout path) when opening the
// session context menu, after the menu is already visible.
type SessionMenuWorkParams = {
  client: Pick<GatewayBrowserClient, "request">;
  /** Omitted when the Gateway does not advertise pushed PR snapshots. */
  loadPullRequests?: () => Promise<ControlUiSessionPullRequestSnapshot | undefined>;
  worktreeId?: string;
  execNode?: string;
};

type SessionMenuWorkResult = {
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

// Menu offers a single Open PR action; prefer the PR a maintainer most
// likely wants: active first, merged history next, closed last.
const PR_STATE_ORDER = ["open", "draft", "merged", "closed"] as const;

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

async function loadPullRequestUrl(params: SessionMenuWorkParams): Promise<string | null> {
  try {
    const snapshot = await params.loadPullRequests?.();
    return pickSessionMenuPullRequestUrl(snapshot?.pullRequests ?? []);
  } catch {
    // Optional affordance: a GitHub or gateway hiccup just leaves Open PR disabled.
    return null;
  }
}

async function loadWorktreePath(params: SessionMenuWorkParams): Promise<string | null> {
  const worktreeId = params.worktreeId;
  if (!worktreeId || params.execNode) {
    return null;
  }
  if (!isNativeLocalGateway()) {
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
