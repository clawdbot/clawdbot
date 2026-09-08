import { runGit } from "../agents/worktrees/git.js";
import { createSessionPullRequestCache } from "./control-ui-session-pr-cache.js";
import {
  gitOutput,
  resolveBranchLanding,
  type MergedPullHead,
} from "./control-ui-session-prs-landing.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

const LOCAL_GIT_CACHE_MS = 75_000;

/** GitHub repo + branch resolved from the session's recorded source or checkout. */
export type SessionPullRequestGitContext = {
  owner: string;
  repo: string;
  branch: string;
  /** Checkout root for local diff stats; absent for repository-only sessions. */
  root?: string;
  /** Remote default branch when origin/HEAD is resolvable. */
  defaultBranch?: string;
};

export type SessionPullRequestLocalGitDeps = {
  cacheSignal?: AbortSignal;
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
  const entries = createSessionPullRequestCache<LocalGitCacheEntry<T>>();
  return {
    load(key: string, refresh: boolean, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const cached = entries.get(key, signal);
      const entry =
        !refresh && cached && cached.expiresAt > Date.now()
          ? cached
          : { expiresAt: Date.now() + LOCAL_GIT_CACHE_MS, promise: load() };
      entries.set(key, entry, signal);
      return entry.promise;
    },
    release: entries.release,
  };
}

// Outlive the 60-second subscription poll so unchanged rows do not respawn
// Git every cycle; explicit structural refreshes still bypass both caches.
const cachedGitContext = createLocalGitCache<SessionPullRequestGitContext | null>();
const cachedBranchFacts = createLocalGitCache<SessionPullRequestBranchFacts | undefined>();

export function releaseSessionPullRequestLocalGitCache(signal?: AbortSignal): void {
  cachedGitContext.release(signal);
  cachedBranchFacts.release(signal);
}

export function releaseSessionPullRequestBranchFacts(signal?: AbortSignal): void {
  cachedBranchFacts.release(signal);
}

export function resolveCachedGitContext(
  root: string,
  deps: SessionPullRequestLocalGitDeps,
  refresh = false,
): Promise<SessionPullRequestGitContext | null> {
  return cachedGitContext.load(
    root,
    refresh,
    async () => {
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
      const defaultRef = await output(root, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const defaultBranch = defaultRef?.replace(/^origin\//, "");
      if (defaultBranch === branch) {
        return null;
      }
      return { ...remote, branch, root, ...(defaultBranch ? { defaultBranch } : {}) };
    },
    deps.cacheSignal,
  );
}

export function resolveCachedSessionBranchFacts(
  context: SessionPullRequestGitContext & { root: string },
  mergedHeads: readonly MergedPullHead[],
  load: () => Promise<SessionPullRequestBranchFacts | undefined>,
  refresh = false,
  signal?: AbortSignal,
): Promise<SessionPullRequestBranchFacts | undefined> {
  const landingKey = JSON.stringify([context.defaultBranch ?? null, mergedHeads]);
  return cachedBranchFacts.load(
    `${context.root}\0${context.branch}\0${landingKey}`,
    refresh,
    load,
    signal,
  );
}
