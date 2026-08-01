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
import {
  gitOutput,
  resolveBranchLanding,
  type MergedPullHead,
} from "./control-ui-session-prs-landing.js";
import {
  resolveCachedGitContext,
  resolveCachedSessionBranchFacts,
  type SessionPullRequestGitContext,
  type SessionPullRequestLocalGitDeps,
} from "./control-ui-session-prs-local-git.js";
import { loadSessionEntryReadOnly } from "./session-utils.js";

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

type PullListItem = {
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  state: ControlUiSessionPullRequest["state"];
  headSha?: string;
  baseRef?: string;
  mergeCommitSha?: string;
};

/**
 * Cached GitHub snapshot plus the merged PRs' heads. The heads stay
 * gateway-internal (stripped before responding): they only exist so branch
 * resolution can tell a landed tip from real post-merge work. Kept as raw
 * GitHub facts because the cache key carries no default branch; each
 * checkout filters them against its own default at resolve time.
 */
type BranchPullRequestsSnapshot = ControlUiSessionPullRequests & {
  mergedHeads: MergedPullHead[];
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<BranchPullRequestsSnapshot>;
  refreshMode: "normal" | "forced" | null;
  // Survives refetch failures so rate-limited refreshes degrade to stale
  // chips instead of clearing the row.
  lastGood?: { pullRequests: ControlUiSessionPullRequest[]; mergedHeads: MergedPullHead[] };
};

const branchCache = new Map<string, CacheEntry>();

type LoadSessionPullRequestDeps = SessionPullRequestLocalGitDeps & {
  fetchImpl?: typeof fetch;
  resolveGitRoot?: (params: ControlUiSessionPullRequestsParams) => Promise<string | null>;
  resolveGitContext?: (
    params: ControlUiSessionPullRequestsParams,
  ) => Promise<SessionPullRequestGitContext | null>;
};

/** Resolves the checkout root without spawning Git. */
function resolveSessionPullRequestGitRoot(
  params: ControlUiSessionPullRequestsParams,
): string | null {
  const { cfg, entry, storePath, canonicalKey } = loadSessionEntryReadOnly(params.sessionKey, {
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
  return root;
}

/**
 * Resolves the GitHub repo + branch, caching detached/default/non-GitHub
 * outcomes too so repeated sidebar requests do not respawn the same probes.
 */
async function resolveSessionPullRequestGitContext(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps,
): Promise<SessionPullRequestGitContext | null> {
  const root = deps.resolveGitRoot
    ? await deps.resolveGitRoot(params)
    : resolveSessionPullRequestGitRoot(params);
  if (!root) {
    return null;
  }
  return resolveCachedGitContext(root, deps);
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
 * chat view's poll, so it must not spawn one git subprocess per path. lstat
 * gates on regular files so FIFOs/sockets can never block the RPC and symlinks
 * never resolve outside the checkout; only a line count is exposed, so
 * sessions-diff's hardlink content guard is unnecessary here.
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

async function untrackedStats(
  root: string,
  output: typeof gitOutput,
): Promise<{ additions: number; files: number }> {
  const listing = await output(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = (listing ?? "").split("\0").filter(Boolean);
  let additions = 0;
  for (const filePath of paths.slice(0, MAX_UNTRACKED_STAT_FILES)) {
    additions += await untrackedFileAdditions(root, filePath);
  }
  return { additions, files: paths.length };
}

/**
 * Working-tree diff counts vs an explicit base, untracked files included:
 * the size the PR would have if the current work were committed and pushed;
 * changedFiles decides row visibility for unpushed branches. Unlike bare
 * `git diff`, this also counts unmerged (conflict) paths.
 */
async function diffStatsAgainst(
  root: string,
  base: string,
  deps: LoadSessionPullRequestDeps,
): Promise<{ additions: number; deletions: number; changedFiles: number } | null> {
  try {
    // Checkout-configurable diff drivers must never execute in the Gateway
    // process (same guard as sessions-diff).
    const result = await (deps.runGit ?? runGit)(root, [
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      base,
    ]);
    if (result.code !== 0) {
      return null;
    }
    // Empty output means an empty diff, not a failure.
    const summary = result.stdout.trim();
    const untracked = await untrackedStats(root, deps.gitOutput ?? gitOutput);
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
 * carries commits the default branch lacks. Rename-only commits still count:
 * this gate keys on commits, not line counts.
 */
async function branchHasCreatablePullRequest(
  root: string,
  context: SessionPullRequestGitContext,
  pushedSha: string | null,
  output: typeof gitOutput,
): Promise<boolean> {
  // Fail closed when origin/HEAD is missing or the branch is not pushed.
  if (!context.defaultBranch || !pushedSha) {
    return false;
  }
  const ahead = await output(root, [
    "rev-list",
    "--count",
    `refs/remotes/origin/${context.defaultBranch}..refs/remotes/origin/${context.branch}`,
  ]);
  // A failed count keeps the row: rev-list errors must not hide a valid branch.
  return ahead === null || Number(ahead) > 0;
}

async function resolveSessionBranch(
  context: SessionPullRequestGitContext,
  mergedHeads: readonly MergedPullHead[],
  deps: LoadSessionPullRequestDeps,
): Promise<ControlUiSessionBranch | undefined> {
  const root = context.root;
  if (!root) {
    // Stubbed test contexts without a root skip the local-git gates.
    return {
      owner: context.owner,
      repo: context.repo,
      branch: context.branch,
      createUrl: branchCreateUrl(context),
    };
  }
  const facts = await resolveCachedSessionBranchFacts(
    { ...context, root },
    mergedHeads,
    async () => {
      const landing = await (deps.resolveBranchLanding ?? resolveBranchLanding)(root, {
        branch: context.branch,
        defaultBranch: context.defaultBranch,
        mergedHeads,
      });
      const creatable =
        (!landing.hasLandedPullRequest || landing.provenNewPushedWork) &&
        (await branchHasCreatablePullRequest(
          root,
          context,
          landing.pushedSha,
          deps.gitOutput ?? gitOutput,
        ));
      const stats = landing.statsBase
        ? await diffStatsAgainst(root, landing.statsBase, deps)
        : null;
      // No createUrl until GitHub can compare, but local changes still get a row.
      return !creatable && !(stats && stats.changedFiles > 0) ? undefined : { creatable, stats };
    },
  );
  if (!facts) {
    return undefined;
  }
  return {
    owner: context.owner,
    repo: context.repo,
    branch: context.branch,
    ...(facts.creatable ? { createUrl: branchCreateUrl(context) } : {}),
    ...(facts.stats ? { additions: facts.stats.additions, deletions: facts.stats.deletions } : {}),
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
    baseRef: optionalString(base, "ref"),
    mergeCommitSha: optionalString(value, "merge_commit_sha"),
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

function mergedHeadsOf(items: readonly PullListItem[]): MergedPullHead[] {
  const heads: MergedPullHead[] = [];
  for (const item of items) {
    if (item.state === "merged" && item.headSha) {
      heads.push({
        sha: item.headSha.toLowerCase(),
        ...(item.baseRef ? { baseRef: item.baseRef } : {}),
        ...(item.mergeCommitSha ? { mergeCommitSha: item.mergeCommitSha.toLowerCase() } : {}),
      });
    }
  }
  return heads;
}

async function fetchBranchPullRequests(
  context: SessionPullRequestGitContext,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<BranchPullRequestsSnapshot> {
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
  const mergedHeads = mergedHeadsOf(capped);
  try {
    const pullRequests = await Promise.all(
      capped.map((item) => finishPullRequest(item, context.branch, fetchImpl, token)),
    );
    return { pullRequests, rateLimited: false, mergedHeads };
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
      mergedHeads,
    };
  }
}

async function refreshBranchPullRequests(
  context: SessionPullRequestGitContext,
  fetchImpl: typeof fetch,
  entry: CacheEntry,
): Promise<BranchPullRequestsSnapshot> {
  try {
    const result = await fetchBranchPullRequests(context, fetchImpl, githubApiToken());
    // Degraded state-only chips still become lastGood: a later refresh that
    // rate-limits at the list fetch must serve the proven PRs, not an empty
    // list that would resurrect the Create PR row mid-outage. The shortened
    // expiry makes the next window retry full detail.
    entry.lastGood = { pullRequests: result.pullRequests, mergedHeads: result.mergedHeads };
    if (result.rateLimited) {
      entry.expiresAt = Date.now() + RATE_LIMIT_CACHE_MS;
    }
    return result;
  } catch (error) {
    const rateLimited = error instanceof ControlUiGitHubError && error.statusCode === 429;
    entry.expiresAt = Date.now() + (rateLimited ? RATE_LIMIT_CACHE_MS : FAILURE_CACHE_MS);
    if (rateLimited) {
      return { pullRequests: [], mergedHeads: [], ...entry.lastGood, rateLimited: true };
    }
    if (entry.lastGood) {
      return { ...entry.lastGood, rateLimited: false };
    }
    throw error;
  }
}

export async function loadControlUiSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
  deps: LoadSessionPullRequestDeps = {},
): Promise<ControlUiSessionPullRequests> {
  const context = deps.resolveGitContext
    ? await deps.resolveGitContext(params)
    : await resolveSessionPullRequestGitContext(params, deps);
  if (!context) {
    return { pullRequests: [], rateLimited: false };
  }
  // Local Git uses a separate short TTL; refresh only forces the GitHub layer.
  // Branch resolution follows the snapshot because merged head SHAs affect it.
  const { mergedHeads, ...snapshot } = await cachedBranchPullRequests(
    context,
    deps,
    params.refresh === true,
  );
  const branch = await resolveSessionBranch(context, mergedHeads, deps);
  return branch ? { ...snapshot, branch } : snapshot;
}

function trackBranchRefresh(
  entry: CacheEntry,
  mode: "normal" | "forced",
  load: () => Promise<BranchPullRequestsSnapshot>,
): Promise<BranchPullRequestsSnapshot> {
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
): Promise<BranchPullRequestsSnapshot> {
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
    promise: Promise.resolve({ pullRequests: [], rateLimited: false, mergedHeads: [] }),
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
