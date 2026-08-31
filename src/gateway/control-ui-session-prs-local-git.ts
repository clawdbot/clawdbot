import { runGit } from "../agents/worktrees/git.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  gitOutput,
  resolveBranchLanding,
  type MergedPullHead,
} from "./control-ui-session-prs-landing.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

const LOCAL_GIT_CACHE_MS = 75_000;
const LOCAL_GIT_CACHE_LIMIT = 100;

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

export type SessionPullRequestLocalGitDeps = {
  gitOutput?: typeof gitOutput;
  runGit?: typeof runGit;
  resolveBranchLanding?: typeof resolveBranchLanding;
};

type SessionPullRequestBranchFacts = {
  creatable: boolean;
  stats: { additions: number; deletions: number; changedFiles: number } | null;
};

type LocalGitCacheEntry<T> = { expiresAt: number; promise: Promise<T> };

function createLocalGitCache<T>() {
  const entries = new Map<string, LocalGitCacheEntry<T>>();
  return (key: string, refresh: boolean, load: () => Promise<T>): Promise<T> => {
    const cached = entries.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.promise;
    }
    const entry = { expiresAt: Date.now() + LOCAL_GIT_CACHE_MS, promise: load() };
    entries.delete(key);
    entries.set(key, entry);
    pruneMapToMaxSize(entries, LOCAL_GIT_CACHE_LIMIT);
    return entry.promise;
  };
}

// Outlive the 60-second subscription poll so unchanged rows do not respawn
// Git every cycle; explicit structural refreshes still bypass both caches.
const cachedGitContext = createLocalGitCache<SessionPullRequestGitContext | null>();
const cachedBranchFacts = createLocalGitCache<SessionPullRequestBranchFacts | undefined>();

export function resolveCachedGitContext(
  root: string,
  deps: SessionPullRequestLocalGitDeps,
  refresh = false,
): Promise<SessionPullRequestGitContext | null> {
  return cachedGitContext(root, refresh, async () => {
    const output = deps.gitOutput ?? gitOutput;
    const branch = await output(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") {
      return null;
    }
    const remoteUrl = await output(root, ["remote", "get-url", "origin"]);
    const remote = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;
    if (!remote) {
      return null;
    }
    const defaultRef = await output(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const defaultBranch = defaultRef?.replace(/^origin\//, "");
    if (defaultBranch === branch) {
      return null;
    }
    return { ...remote, branch, root, ...(defaultBranch ? { defaultBranch } : {}) };
  });
}

export function resolveCachedSessionBranchFacts(
  context: SessionPullRequestGitContext & { root: string },
  mergedHeads: readonly MergedPullHead[],
  load: () => Promise<SessionPullRequestBranchFacts | undefined>,
  refresh = false,
): Promise<SessionPullRequestBranchFacts | undefined> {
  const landingKey = JSON.stringify([context.defaultBranch ?? null, mergedHeads]);
  return cachedBranchFacts(`${context.root}\0${context.branch}\0${landingKey}`, refresh, load);
}
