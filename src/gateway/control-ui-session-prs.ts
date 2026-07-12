// Detects GitHub pull requests for a session's working branch so the Control
// UI chat view can pin PR status chips above the composer.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { runGit } from "../agents/worktrees/git.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import {
  ControlUiGitHubError,
  fetchGitHubJson,
  GITHUB_API_ORIGIN,
  githubApiToken,
  isRecord,
  optionalNumber,
  optionalString,
} from "./control-ui-github-api.js";
import { loadSessionEntry } from "./session-utils.js";

const SUCCESS_CACHE_MS = 60_000;
// Back off refetches while GitHub reports quota exhaustion; the UI keeps
// showing the last-known chips with the stale warning during this window.
const RATE_LIMIT_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;
const MAX_PULL_REQUESTS = 3;

export type ControlUiSessionPullRequestsParams = {
  sessionKey: string;
  agentId?: string;
};

/** GitHub repo + branch resolved from a session's git checkout. */
export type SessionPullRequestGitContext = {
  owner: string;
  repo: string;
  branch: string;
  /** Checkout root for local diff stats; absent for stubbed test contexts. */
  root?: string;
  /** Remote default branch when origin/HEAD is resolvable. */
  defaultBranch?: string;
};

type PullListItem = {
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  state: ControlUiSessionPullRequest["state"];
  headSha?: string;
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<ControlUiSessionPullRequests>;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: ControlUiSessionPullRequest[];
};

const branchCache = new Map<string, CacheEntry>();

export function resetControlUiSessionPullRequestCacheForTests(): void {
  branchCache.clear();
}

export function parseControlUiSessionPullRequestsParams(
  value: unknown,
): ControlUiSessionPullRequestsParams | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionKey = typeof value.sessionKey === "string" ? value.sessionKey.trim() : "";
  if (!sessionKey) {
    return null;
  }
  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  return agentId ? { sessionKey, agentId } : { sessionKey };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    if (result.code !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Parses a GitHub `origin` remote (https, ssh, or scp-like) to owner/repo. */
export function parseGitHubRemoteUrl(raw: string): { owner: string; repo: string } | null {
  const trimmed = raw.trim();
  let path: string | undefined;
  const scpMatch = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scpMatch) {
    path = scpMatch[1];
  } else {
    try {
      const url = new URL(trimmed);
      const protocolOk =
        url.protocol === "https:" || url.protocol === "http:" || url.protocol === "ssh:";
      if (!protocolOk || url.hostname.toLowerCase() !== "github.com") {
        return null;
      }
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = (path ?? "").split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  if (segments.length !== 2 || !owner || !repo) {
    return null;
  }
  return { owner, repo };
}

/**
 * Resolves the GitHub repo + branch a session works on. Returns null for
 * unknown sessions, non-git roots, detached HEADs, non-GitHub remotes, and
 * the remote default branch (no PR can have the default branch as head from
 * the same checkout, and skipping it protects the anonymous GitHub quota for
 * plain sessions).
 */
export async function resolveSessionPullRequestGitContext(
  params: ControlUiSessionPullRequestsParams,
): Promise<SessionPullRequestGitContext | null> {
  const { cfg, entry, storePath, canonicalKey } = loadSessionEntry(params.sessionKey, {
    agentId: params.agentId,
  });
  // Same session/agent scoping as sessions.files.*: a missing entry means an
  // unknown or deleted session, which must not fall back to some agent
  // workspace and surface another checkout's PRs.
  if (!entry?.sessionId || !storePath) {
    return null;
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg),
  );
  const root =
    normalizeOptionalString(entry.spawnedCwd) ??
    normalizeOptionalString(entry.spawnedWorkspaceDir) ??
    normalizeOptionalString(resolveAgentWorkspaceDir(cfg, agentId));
  if (!root) {
    return null;
  }
  const branch = await gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    return null;
  }
  const remoteUrl = await gitOutput(root, ["remote", "get-url", "origin"]);
  const remote = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;
  if (!remote) {
    return null;
  }
  const defaultRef = await gitOutput(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultBranch = defaultRef?.replace(/^origin\//, "");
  if (defaultBranch === branch) {
    return null;
  }
  return { ...remote, branch, root, ...(defaultBranch ? { defaultBranch } : {}) };
}

// git push's own "create a pull request" hint URL; GitHub resolves the base
// branch (including fork -> parent) so no API call is needed to build it.
function branchCreateUrl(context: SessionPullRequestGitContext): string {
  const owner = encodeURIComponent(context.owner);
  const repo = encodeURIComponent(context.repo);
  const branch = context.branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/pull/new/${branch}`;
}

const SHORTSTAT_INSERTIONS = /(\d+) insertion/;
const SHORTSTAT_DELETIONS = /(\d+) deletion/;
// Matches sessions-diff's untracked scan bound; stats degrade to an
// undercount past it instead of stalling the request.
const MAX_UNTRACKED_STAT_FILES = 100;

async function untrackedAdditions(root: string): Promise<number> {
  const listing = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!listing) {
    return 0;
  }
  const paths = listing.split("\0").filter(Boolean);
  let additions = 0;
  // Counts only, never patch content, so the hardlink/symlink content guards
  // in sessions-diff are unnecessary here; binary files count as 0 lines.
  for (const filePath of paths.slice(0, MAX_UNTRACKED_STAT_FILES)) {
    try {
      const result = await runGit(root, [
        "diff",
        "--shortstat",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--",
        "/dev/null",
        filePath,
      ]);
      // Exit code 1 is git's "files differ" for --no-index, not a failure.
      if (result.code === 0 || result.code === 1) {
        additions += Number(SHORTSTAT_INSERTIONS.exec(result.stdout.trim())?.[1] ?? 0);
      }
    } catch {
      // Unreadable paths just do not count toward the size.
    }
  }
  return additions;
}

/**
 * Working-tree diff counts vs the merge base with the remote default branch,
 * untracked files included: the size the PR would have if the current work
 * were committed and pushed.
 */
async function loadBranchDiffStats(
  root: string,
  defaultBranch: string,
): Promise<{ additions: number; deletions: number } | null> {
  const mergeBase = await gitOutput(root, [
    "merge-base",
    `refs/remotes/origin/${defaultBranch}`,
    "HEAD",
  ]);
  if (!mergeBase) {
    return null;
  }
  try {
    // --no-ext-diff/--no-textconv: checkout-configurable diff drivers must
    // never execute in the Gateway process (same guard as sessions-diff).
    const result = await runGit(root, [
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      mergeBase,
    ]);
    if (result.code !== 0) {
      return null;
    }
    // Empty output means an empty diff, not a failure.
    const summary = result.stdout.trim();
    return {
      additions:
        Number(SHORTSTAT_INSERTIONS.exec(summary)?.[1] ?? 0) + (await untrackedAdditions(root)),
      deletions: Number(SHORTSTAT_DELETIONS.exec(summary)?.[1] ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * GitHub's pull/new page only has something to offer once the pushed branch
 * carries commits the default branch lacks; unpushed or fully-merged remote
 * branches get "nothing to compare" (or a 404), so the row stays hidden.
 * Rename-only or zero-line-delta commits still count — visibility keys on
 * commits, not on line counts.
 */
async function branchHasCreatablePullRequest(
  root: string,
  context: SessionPullRequestGitContext,
): Promise<boolean> {
  // Fail closed without a resolvable default branch: a session sitting on the
  // actual default in a clone lacking origin/HEAD must not get a Create PR row.
  if (!context.defaultBranch) {
    return false;
  }
  const remoteRef = `refs/remotes/origin/${context.branch}`;
  const pushed = await gitOutput(root, ["rev-parse", "--verify", "--quiet", remoteRef]);
  if (!pushed) {
    return false;
  }
  const ahead = await gitOutput(root, [
    "rev-list",
    "--count",
    `refs/remotes/origin/${context.defaultBranch}..${remoteRef}`,
  ]);
  // A failed count keeps the row: rev-list errors must not hide a valid branch.
  return ahead === null || Number(ahead) > 0;
}

async function resolveSessionBranch(
  context: SessionPullRequestGitContext,
): Promise<ControlUiSessionBranch | undefined> {
  // Stubbed test contexts without a root skip the local-git gate.
  if (context.root && !(await branchHasCreatablePullRequest(context.root, context))) {
    return undefined;
  }
  const stats =
    context.root && context.defaultBranch
      ? await loadBranchDiffStats(context.root, context.defaultBranch)
      : null;
  return {
    owner: context.owner,
    repo: context.repo,
    branch: context.branch,
    createUrl: branchCreateUrl(context),
    ...stats,
  };
}

function derivePullState(value: Record<string, unknown>): ControlUiSessionPullRequest["state"] {
  if (optionalString(value, "merged_at")) {
    return "merged";
  }
  if (value.state !== "open") {
    return "closed";
  }
  return value.draft === true ? "draft" : "open";
}

function parsePullListItem(value: unknown): PullListItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const number = optionalNumber(value, "number");
  const title = optionalString(value, "title");
  const url = optionalString(value, "html_url");
  const base = isRecord(value.base) ? value.base : {};
  const baseRepo = isRecord(base.repo) ? base.repo : {};
  const baseOwner = isRecord(baseRepo.owner) ? baseRepo.owner : {};
  const owner = optionalString(baseOwner, "login");
  const repo = optionalString(baseRepo, "name");
  const head = isRecord(value.head) ? value.head : {};
  if (!number || !Number.isSafeInteger(number) || number < 1 || !title || !url || !owner || !repo) {
    return null;
  }
  return {
    number,
    title,
    url,
    owner,
    repo,
    state: derivePullState(value),
    headSha: optionalString(head, "sha"),
  };
}

function parsePullList(value: unknown): PullListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parsePullListItem).filter((item): item is PullListItem => item !== null);
}

function pullsByHeadUrl(owner: string, repo: string, head: string): string {
  const encOwner = encodeURIComponent(owner);
  const encRepo = encodeURIComponent(repo);
  const encHead = encodeURIComponent(head);
  return `${GITHUB_API_ORIGIN}/repos/${encOwner}/${encRepo}/pulls?head=${encHead}&state=all&sort=updated&direction=desc&per_page=5`;
}

async function fetchParentRepo(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<{ owner: string; repo: string } | null> {
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const value = await fetchGitHubJson(url, fetchImpl, token);
  if (!isRecord(value) || value.fork !== true || !isRecord(value.parent)) {
    return null;
  }
  const parentOwner = isRecord(value.parent.owner) ? value.parent.owner : {};
  const parentLogin = optionalString(parentOwner, "login");
  const parentName = optionalString(value.parent, "name");
  return parentLogin && parentName ? { owner: parentLogin, repo: parentName } : null;
}

// Sub-fetch degradation: quota errors abort the whole refresh (so the caller
// serves stale chips with the rate-limit flag); anything else just drops the
// optional field the sub-fetch would have filled.
function rethrowRateLimit(error: unknown): void {
  if (error instanceof ControlUiGitHubError && error.statusCode === 429) {
    throw error;
  }
}

async function fetchDiffCounts(
  item: PullListItem,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<{ additions?: number; deletions?: number }> {
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/pulls/${item.number}`;
  try {
    const value = await fetchGitHubJson(url, fetchImpl, token);
    if (!isRecord(value)) {
      return {};
    }
    return {
      additions: optionalNumber(value, "additions"),
      deletions: optionalNumber(value, "deletions"),
    };
  } catch (error) {
    rethrowRateLimit(error);
    return {};
  }
}

const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

function rollupCheckRuns(value: unknown): ControlUiSessionPullRequest["checks"] {
  if (!isRecord(value) || !Array.isArray(value.check_runs) || value.check_runs.length === 0) {
    return undefined;
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;
  for (const runValue of value.check_runs) {
    const run = isRecord(runValue) ? runValue : {};
    const conclusion = optionalString(run, "conclusion");
    if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
      failed += 1;
      continue;
    }
    // "stale" means GitHub invalidated the run (for example a new push), so
    // its old verdict must not read as green.
    if (run.status !== "completed" || conclusion === "stale") {
      running += 1;
      continue;
    }
    if (conclusion === "skipped") {
      skipped += 1;
      continue;
    }
    passed += 1;
  }
  const state = failed > 0 ? "failing" : running > 0 ? "pending" : "passing";
  return { state, passed, failed, skipped, running };
}

async function fetchChecks(
  item: PullListItem,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<ControlUiSessionPullRequest["checks"]> {
  if (!item.headSha || !/^[0-9a-f]{40}$/i.test(item.headSha)) {
    return undefined;
  }
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/commits/${item.headSha}/check-runs?per_page=100`;
  try {
    return rollupCheckRuns(await fetchGitHubJson(url, fetchImpl, token));
  } catch (error) {
    rethrowRateLimit(error);
    return undefined;
  }
}

async function finishPullRequest(
  item: PullListItem,
  branch: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<ControlUiSessionPullRequest> {
  const chip: ControlUiSessionPullRequest = {
    number: item.number,
    owner: item.owner,
    repo: item.repo,
    branch,
    title: item.title,
    url: item.url,
    state: item.state,
  };
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const [counts, checks] = await Promise.all([
    fetchDiffCounts(item, fetchImpl, token),
    fetchChecks(item, fetchImpl, token),
  ]);
  return {
    ...chip,
    ...counts,
    ...(checks ? { checks, checksUrl: `${item.url}/checks` } : {}),
  };
}

async function fetchBranchPullRequests(
  context: SessionPullRequestGitContext,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<ControlUiSessionPullRequest[]> {
  const head = `${context.owner}:${context.branch}`;
  let items = parsePullList(
    await fetchGitHubJson(pullsByHeadUrl(context.owner, context.repo, head), fetchImpl, token),
  );
  if (items.length === 0) {
    // Fork flow: the branch lives on the fork but PRs open against the parent.
    const parent = await fetchParentRepo(context.owner, context.repo, fetchImpl, token);
    if (parent) {
      items = parsePullList(
        await fetchGitHubJson(pullsByHeadUrl(parent.owner, parent.repo, head), fetchImpl, token),
      );
    }
  }
  return await Promise.all(
    items
      .slice(0, MAX_PULL_REQUESTS)
      .map((item) => finishPullRequest(item, context.branch, fetchImpl, token)),
  );
}

async function refreshBranchPullRequests(
  context: SessionPullRequestGitContext,
  fetchImpl: typeof fetch,
  entry: CacheEntry,
): Promise<ControlUiSessionPullRequests> {
  try {
    const pullRequests = await fetchBranchPullRequests(context, fetchImpl, githubApiToken());
    entry.lastGood = pullRequests;
    return { pullRequests, rateLimited: false };
  } catch (error) {
    const rateLimited = error instanceof ControlUiGitHubError && error.statusCode === 429;
    entry.expiresAt = Date.now() + (rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
    if (rateLimited) {
      return { pullRequests: entry.lastGood ?? [], rateLimited: true };
    }
    if (entry.lastGood) {
      return { pullRequests: entry.lastGood, rateLimited: false };
    }
    throw error;
  }
}

export type LoadSessionPullRequestDeps = {
  fetchImpl?: typeof fetch;
  resolveGitContext?: (
    params: ControlUiSessionPullRequestsParams,
  ) => Promise<SessionPullRequestGitContext | null>;
};

export async function loadControlUiSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps = {},
): Promise<ControlUiSessionPullRequests> {
  const resolveGitContext = deps.resolveGitContext ?? resolveSessionPullRequestGitContext;
  const context = await resolveGitContext(params);
  if (!context) {
    return { pullRequests: [], rateLimited: false };
  }
  // Branch metadata is local git only, so it stays fresh per request (the
  // working-tree diff moves while the agent works) and keeps the pre-PR row
  // alive when GitHub is rate limited; only the GitHub fetch is cached.
  const [branch, snapshot] = await Promise.all([
    resolveSessionBranch(context),
    cachedBranchPullRequests(context, deps),
  ]);
  return branch ? { ...snapshot, branch } : snapshot;
}

function cachedBranchPullRequests(
  context: SessionPullRequestGitContext,
  deps: LoadSessionPullRequestDeps,
): Promise<ControlUiSessionPullRequests> {
  const key = `${context.owner.toLowerCase()}/${context.repo.toLowerCase()}#${context.branch}`;
  const cached = branchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    branchCache.delete(key);
    branchCache.set(key, cached);
    return cached.promise;
  }
  const entry: CacheEntry = cached ?? {
    expiresAt: 0,
    promise: Promise.resolve({ pullRequests: [], rateLimited: false }),
  };
  // Optimistic expiry dedupes concurrent panes while the refresh is in
  // flight; failures shorten it inside refreshBranchPullRequests.
  entry.expiresAt = Date.now() + SUCCESS_CACHE_MS;
  entry.promise = refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, entry);
  branchCache.delete(key);
  branchCache.set(key, entry);
  while (branchCache.size > CACHE_LIMIT) {
    const oldestKey = branchCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    branchCache.delete(oldestKey);
  }
  return entry.promise;
}
