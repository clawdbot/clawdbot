import { readSessionProjectionFinalMessageIdentity } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { parseGitHubLinkTarget } from "../../components/github-link-target.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { normalizeFinalAssistantMessage } from "./terminal-message-identity.ts";

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;
const PR_REFRESH_RECEIPT_LIMIT = 200;
const PR_REFRESH_RECEIPT_MAX_CHARS = 4_096;
// GitHub caps owners at 39 and repos at 100 chars; 256 covers a split PR URL.
const STREAM_PR_LINK_TAIL_CHARS = 256;

// History cleanup also calls this owner; its port must not depend on page/event types.
export type PullRequestRefreshHost = UiSessionDefaultsHost & {
  client: GatewayBrowserClient | null;
  connectionEpoch: number;
  sessionKey: string;
  refreshSessionPullRequests?: (options?: { refresh?: boolean }) => boolean;
};

type RefreshOwner = {
  client: PullRequestRefreshHost["client"];
  connectionEpoch: number;
  conversation: string;
  receipts: Set<string>;
  tail?: { runId: string; text: string };
};

const refreshOwners = new WeakMap<object, RefreshOwner>();

export function pullRequestLinksIn(text: unknown): string[] {
  if (typeof text !== "string" || !text.includes("github.com")) {
    return [];
  }
  const links: string[] = [];
  for (const match of text.matchAll(GITHUB_URL_CANDIDATE)) {
    const href = match[0].replace(/[.,;:!?]+$/u, "");
    if (parseGitHubLinkTarget(href)?.kind === "pull") {
      links.push(href);
    }
  }
  return links;
}

function refreshOwner(state: PullRequestRefreshHost): RefreshOwner {
  const conversation = JSON.stringify(resolveUiConversationIdentity(state, state.sessionKey));
  let owner = refreshOwners.get(state);
  if (
    !owner ||
    owner.client !== state.client ||
    owner.connectionEpoch !== state.connectionEpoch ||
    owner.conversation !== conversation
  ) {
    owner = {
      client: state.client,
      connectionEpoch: state.connectionEpoch,
      conversation,
      receipts: new Set(),
    };
    refreshOwners.set(state, owner);
  }
  return owner;
}

function requestRefresh(
  state: PullRequestRefreshHost,
  owner: RefreshOwner,
  key: string | null,
): void {
  const remember = key !== null && key.length <= PR_REFRESH_RECEIPT_MAX_CHARS;
  if (remember && owner.receipts.has(key)) {
    return;
  }
  // Hidden or disconnected panes may decline. Remember actual queue admission,
  // never presentation acceptance or an attempted callback that did no work.
  if (state.refreshSessionPullRequests?.({ refresh: true }) !== true) {
    return;
  }
  // Content identities can contain a whole reply. Oversized and evicted receipts
  // may refresh again; truncating them could suppress a genuinely different final.
  if (!remember) {
    return;
  }
  owner.receipts.add(key);
  if (owner.receipts.size > PR_REFRESH_RECEIPT_LIMIT) {
    const oldest = owner.receipts.values().next().value;
    if (oldest !== undefined) {
      owner.receipts.delete(oldest);
    }
  }
}

/** Structural replacement can keep the session ID; ordinary history does not retire receipts. */
export function retirePullRequestRefreshes(state: object): void {
  refreshOwners.delete(state);
}

/** The first streamed link refreshes promptly; the final separately observes later PR changes. */
export function refreshPullRequestsForStreamedLinks(
  state: PullRequestRefreshHost,
  runId: string | undefined,
  deltaText: string,
): void {
  const owner = refreshOwner(state);
  const runKey = runId ?? "";
  const key = JSON.stringify(["stream", runKey]);
  if (owner.receipts.has(key)) {
    return;
  }
  const joined = (owner.tail?.runId === runKey ? owner.tail.text : "") + deltaText;
  owner.tail = { runId: runKey, text: joined.slice(-STREAM_PR_LINK_TAIL_CHARS) };
  if (pullRequestLinksIn(joined).length > 0) {
    requestRefresh(state, owner, key);
  }
}

/** Only a repeated emitted final is redundant; history and stream receipts cannot consume it. */
export function refreshPullRequestsForFinalReply(
  state: PullRequestRefreshHost,
  runId: string | undefined,
  message: unknown,
): void {
  const identity = readSessionProjectionFinalMessageIdentity(
    normalizeFinalAssistantMessage(message),
  );
  requestRefresh(
    state,
    refreshOwner(state),
    runId && identity ? JSON.stringify(["final", runId, identity]) : null,
  );
}
