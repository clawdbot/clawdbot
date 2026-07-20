// Detects GitHub pull requests for a session's working branch so the Control
// UI chat view can pin PR status chips above the composer.
import fs from "node:fs/promises";
import nodePath from "node:path";
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
import { parseGitHubRemoteUrl } from "./github-remote.js";
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
  refresh?: boolean;
};

/** GitHub repo + branch resolved from a session's git checkout. */
type SessionPullRequestGitContext = {
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
  refreshMode: "normal" | "forced" | null;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: ControlUiSessionPullRequest[];
};

const branchCache = new Map<string, CacheEntry>();

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
  return {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    ...(value.refresh === true ? { refresh: true } : {}),
  };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the GitHub repo + branch a session works on. Returns null for
 * unknown sessions, non-git roots, detached HEADs, non-GitHub remotes, and
 * the remote default branch (no PR can have the default branch as head from
 * the same checkout, and skipping it protects the anonymous GitHub quota for
 * plain sessions).
 */
async function resolveSessionPullRequestGitContext(
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

const SHORTSTAT_FILES = /(\d+) files? changed/;
const SHORTSTAT_INSERTIONS = /(\d+) insertion/;
const SHORTSTAT_DELETIONS = /(\d+) deletion/;
// Matches sessions-diff's untracked scan bound; stats degrade to an
// undercount past it instead of stalling the request.
const MAX_UNTRACKED_STAT_FILES = 100;
// Oversized untracked files count 0 lines instead of being read; the row's
// stats are an approximation, not a patch surface.
const MAX_UNTRACKED_STAT_BYTES = 512 * 1024;

/**
 * Line count for one untracked file, computed in-process: this runs on the
 * chat view's 60s poll, so it must not spawn one git subprocess per path.
 * lstat gates on regular files so FIFOs/sockets can never block the RPC and
 * symlinks never resolve outside the checkout; only a line count is exposed,
 * so sessions-diff's hardlink content guard is unnecessary here.
 */
async function untrackedFileAdditions(root: string, filePath: string): Promise<number> {
  try {
    const abs = nodePath.resolve(root, filePath);
    const info = await fs.lstat(abs);
    if (!info.isFile() || info.size === 0 || info.size > MAX_UNTRACKED_STAT_BYTES) {
      return 0;
    }
    const body = await fs.readFile(abs);
    // Binary files count 0 lines, mirroring git's shortstat behavior.
    if (body.subarray(0, 8192).includes(0)) {
      return 0;
    }
    let lines = 0;
    for (const byte of body) {
      if (byte === 10) {
        lines += 1;
      }
    }
    // A trailing fragment without a newline is still a line git would add.
    return body[body.length - 1] === 10 ? lines : lines + 1;
  } catch {
    // Unreadable paths just do not count toward the size.
    return 0;
  }
}

async function untrackedStats(root: string): Promise<{ additions: number; files: number }> {
  const listing = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listing ?? "").split("\0").filter(Boolean);
  let additions = 0;
  for (const filePath of paths.slice(0, MAX_UNTRACKED_STAT_FILES)) {
    additions += await untrackedFileAdditions(root, filePath);
  }
  return { additions, files: paths.length };
}

/**
 * Working-tree diff counts vs the merge base with the remote default branch,
 * untracked files included: the size the PR would have if the current work
 * were committed and pushed; changedFiles decides row visibility for
 * unpushed branches. Unlike bare `git diff`, diffing against an explicit
 * base counts unmerged (conflict) paths, so conflict-only trees still show.
 */
async function loadBranchDiffStats(
  root: string,
  defaultBranch: string,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
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
    const untracked = await untrackedStats(root);
    return {
      additions: Number(SHORTSTAT_INSERTIONS.exec(summary)?.[1] ?? 0) + untracked.additions,
      deletions: Number(SHORTSTAT_DELETIONS.exec(summary)?.[1] ?? 0),
      changedFiles: Number(SHORTSTAT_FILES.exec(summary)?.[1] ?? 0) + untracked.files,
    };
  } catch {
    return null;
  }
}

/**
 * GitHub's pull/new page only has something to offer once the pushed branch
 * carries commits the default branch lacks; unpushed or fully-merged remote
 * branches get "nothing to compare" (or a 404), so createUrl is withheld and
 * the row only reports local changed files. Rename-only commits still count —
 * this gate keys on commits, not line counts.
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
  // Stubbed test contexts without a root skip the local-git gates.
  const creatable = !context.root || (await branchHasCreatablePullRequest(context.root, context));
  const stats =
    context.root && context.defaultBranch
      ? await loadBranchDiffStats(context.root, context.defaultBranch)
      : null;
  // No createUrl until GitHub can compare, but local changes still get a row.
  if (!creatable && !(stats && stats.changedFiles > 0)) {
    return undefined;
  }
  return {
    owner: context.owner,
    repo: context.repo,
    branch: context.branch,
    ...(creatable ? { createUrl: branchCreateUrl(context) } : {}),
    ...(stats ? { additions: stats.additions, deletions: stats.deletions } : {}),
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
): Promise<{ pullRequests: ControlUiSessionPullRequest[]; rateLimited: boolean }> {
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
  const capped = items.slice(0, MAX_PULL_REQUESTS);
  try {
    const pullRequests = await Promise.all(
      capped.map((item) => finishPullRequest(item, context.branch, fetchImpl, token)),
    );
    return { pullRequests, rateLimited: false };
  } catch (error) {
    if (!(error instanceof ControlUiGitHubError && error.statusCode === 429)) {
      throw error;
    }
    // Quota ran out between the list fetch and the per-PR detail fetches:
    // keep the proven PR list as state-only chips instead of dropping it, or
    // a cold cache would show a Create PR row despite a known open PR.
    return {
      pullRequests: capped.map((item) => ({
        number: item.number,
        owner: item.owner,
        repo: item.repo,
        branch: context.branch,
        title: item.title,
        url: item.url,
        state: item.state,
      })),
      rateLimited: true,
    };
  }
}

async function refreshBranchPullRequests(
  context: SessionPullRequestGitContext,
  fetchImpl: typeof fetch,
  entry: CacheEntry,
): Promise<ControlUiSessionPullRequests> {
  try {
    const result = await fetchBranchPullRequests(context, fetchImpl, githubApiToken());
    // Degraded state-only chips still become lastGood: a later refresh that
    // rate-limits at the list fetch must serve the proven PRs, not an empty
    // list that would resurrect the Create PR row mid-outage. The shortened
    // expiry makes the next window retry full detail.
    entry.lastGood = result.pullRequests;
    if (result.rateLimited) {
      entry.expiresAt = Date.now() + RATE_LIMIT_CACHE_MS;
    }
    return result;
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

type LoadSessionPullRequestDeps = {
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
    cachedBranchPullRequests(context, deps, params.refresh === true),
  ]);
  return branch ? { ...snapshot, branch } : snapshot;
}

function trackBranchRefresh(
  entry: CacheEntry,
  mode: "normal" | "forced",
  load: () => Promise<ControlUiSessionPullRequests>,
): Promise<ControlUiSessionPullRequests> {
  // Publish the replacement promise before any awaited work so later callers
  // cannot overtake a queued forced refresh with an older normal result.
  entry.expiresAt = Date.now() + SUCCESS_CACHE_MS;
  entry.refreshMode = mode;
  const refreshPromise = load();
  const trackedPromise = refreshPromise.finally(() => {
    if (entry.promise === trackedPromise) {
      entry.refreshMode = null;
    }
  });
  entry.promise = trackedPromise;
  return trackedPromise;
}

async function cachedBranchPullRequests(
  context: SessionPullRequestGitContext,
  deps: LoadSessionPullRequestDeps,
  refresh: boolean,
): Promise<ControlUiSessionPullRequests> {
  const key = `${context.owner.toLowerCase()}/${context.repo.toLowerCase()}#${context.branch}`;
  const cached = branchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    branchCache.delete(key);
    branchCache.set(key, cached);
    if (!refresh || cached.refreshMode === "forced") {
      return cached.promise;
    }
    const pendingSnapshot = cached.promise;
    const pendingRefreshMode = cached.refreshMode;
    const pendingExpiresAt = cached.expiresAt;
    return trackBranchRefresh(cached, "forced", async () => {
      const snapshot = await pendingSnapshot;
      // GitHub quota backoff stays authoritative even when a PR announcement
      // queues this lookup behind an older normal or settled request.
      if (snapshot.rateLimited) {
        if (pendingRefreshMode === null) {
          cached.expiresAt = pendingExpiresAt;
        }
        return snapshot;
      }
      return refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, cached);
    });
  }
  const entry: CacheEntry = cached ?? {
    expiresAt: 0,
    promise: Promise.resolve({ pullRequests: [], rateLimited: false }),
    refreshMode: null,
  };
  const promise = trackBranchRefresh(entry, refresh ? "forced" : "normal", () =>
    refreshBranchPullRequests(context, deps.fetchImpl ?? fetch, entry),
  );
  branchCache.delete(key);
  branchCache.set(key, entry);
  while (branchCache.size > CACHE_LIMIT) {
    const oldestKey = branchCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    branchCache.delete(oldestKey);
  }
  return promise;
}
