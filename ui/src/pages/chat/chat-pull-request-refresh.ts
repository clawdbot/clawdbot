import { parseGitHubLinkTarget } from "../../components/github-link-target.ts";
import type { ChatEventPayload } from "./chat-gateway.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;

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

// Bounds the refreshed-run set; clearing at worst re-fires one refresh per run.
const STREAM_PR_REFRESH_RUN_LIMIT = 200;
// Longest URL prefix worth carrying across delta chunks. GitHub caps owners at
// 39 and repos at 100 chars, so a maximal PR URL is ~175 chars; 256 covers it.
const STREAM_PR_LINK_TAIL_CHARS = 256;

/**
 * A PR created or merged mid-turn should surface a chip right away instead of
 * waiting for the terminal reply or the minute poll, so the first streamed
 * sighting of a PR link forces one chips refresh. At most one per run: the
 * refresh reloads all of the branch's PRs regardless of which link fired it,
 * so more links in the same run add GitHub quota cost without information,
 * while a later run announcing a state change (created -> merged) refreshes
 * again. Deltas are arbitrary fragments, so a short rolling tail rejoins URLs
 * split across chunks; a link the tail still misses is caught by the
 * final-reply trigger. That terminal trigger intentionally refreshes again
 * even after a stream refresh — state often changes between the announcement
 * and the end of the turn (created -> merged) — bounding forced refreshes at
 * two per run, coalesced by the gateway while one is in flight.
 */
export function refreshPullRequestsForStreamedLinks(
  state: ChatPageHost,
  payload: ChatEventPayload,
  deltaText: string,
): void {
  const scope = `${payload.sessionKey}|${payload.runId ?? ""}`;
  const tail = state.streamPullRequestTail;
  // The tail is scoped like the refresh: joining across runs would falsely
  // complete split URLs.
  const joined = (tail?.scope === scope ? tail.text : "") + deltaText;
  state.streamPullRequestTail = { scope, text: joined.slice(-STREAM_PR_LINK_TAIL_CHARS) };
  const seen = (state.streamPullRequestRefreshKeys ??= new Set());
  if (seen.has(scope) || pullRequestLinksIn(joined).length === 0) {
    return;
  }
  if (seen.size > STREAM_PR_REFRESH_RUN_LIMIT) {
    seen.clear();
  }
  seen.add(scope);
  void state.refreshSessionPullRequests?.({ refresh: true });
}
