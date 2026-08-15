import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import {
  evictPullRequestCache,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";

describe("session branch diff stats", () => {
  const execFileAsync = promisify(execFile);
  let root: string;

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd: root,
    });

  const writeFile = (file: string, contents: string | Uint8Array) =>
    fs.writeFile(path.join(root, file), contents);
  const appendFile = (file: string, contents: string) =>
    fs.appendFile(path.join(root, file), contents);

  const commit = async (message: string, ...files: string[]) => {
    await git("add", ...files);
    await git("commit", "-m", message);
  };

  const writeCommit = async (file: string, contents: string, message: string) => {
    await writeFile(file, contents);
    await commit(message, file);
  };

  const appendCommit = async (file: string, contents: string, message: string) => {
    await appendFile(file, contents);
    await commit(message, file);
  };

  const trackRemote = (branch: string, revision = "HEAD") =>
    git("update-ref", `refs/remotes/origin/${branch}`, revision);
  const resolveRevision = async (revision: string) =>
    (await git("rev-parse", revision)).stdout.trim();

  const initializeRepo = async (initialContents = "one\n") => {
    await git("init", "--initial-branch=main", ".");
    await writeCommit("a.txt", initialContents, "base");
  };

  const initializeFeatureBranch = async (initialContents = "one\n") => {
    await initializeRepo(initialContents);
    await trackRemote("main");
    await git("checkout", "-b", "feature");
  };

  type FeatureWorkOptions = {
    message?: string;
    trackFeature?: boolean;
    trackMain?: boolean;
  };

  const initializeFeatureWork = async ({
    message = "feature work",
    trackMain = true,
    trackFeature = false,
  }: FeatureWorkOptions = {}) => {
    await initializeRepo();
    if (trackMain) {
      await trackRemote("main");
    }
    await git("checkout", "-b", "feature");
    await appendCommit("a.txt", "two\n", message);
    if (trackFeature) {
      await trackRemote("feature");
    }
  };

  const initializeFeatureHead = async (options: FeatureWorkOptions = {}) => {
    await initializeFeatureWork(options);
    return resolveRevision(options.trackFeature ? "refs/remotes/origin/feature" : "HEAD");
  };

  const mergedPull = (headSha: string, overrides: Record<string, unknown> = {}) =>
    pullListItem({
      state: "closed",
      merged_at: "2026-07-01T00:00:00Z",
      head: { sha: headSha },
      ...overrides,
    });

  const loadBranchState = async ({
    pullRequests,
    defaultBranch = "main",
  }: {
    pullRequests?: Array<Record<string, unknown>>;
    defaultBranch?: string | null;
  } = {}) => {
    const routes = [{ match: "/pulls?head=", response: () => githubJson(pullRequests ?? []) }];
    if (pullRequests === undefined) {
      routes.push({
        match: "/repos/openclaw/openclaw",
        response: () => githubJson({ fork: false }),
      });
    }
    return loadControlUiSessionPullRequests(
      { sessionKey: "agent:main:main" },
      {
        fetchImpl: routedFetch(routes),
        resolveGitContext: async () => ({
          ...context,
          branch: "feature",
          root,
          ...(defaultBranch === null ? {} : { defaultBranch }),
        }),
      },
    );
  };

  const loadMergedBranchState = (headSha: string, overrides: Record<string, unknown> = {}) =>
    loadBranchState({ pullRequests: [mergedPull(headSha, overrides)] });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-prs-")));
  });

  afterEach(async () => {
    await evictPullRequestCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("counts committed and uncommitted changes vs the origin default merge base", async () => {
    await initializeFeatureBranch("one\ntwo\n");
    // Stand in for the remote default branch without a real remote.
    await writeFile("a.txt", "one\nthree\n");
    await writeFile("b.txt", "committed\n");
    await commit("feature work", "a.txt", "b.txt");
    await trackRemote("feature");
    // Uncommitted work counts too: the row sizes the PR the push would open.
    await appendFile("b.txt", "pending\n");
    // Untracked files count toward additions as well.
    await writeFile("c.txt", "brand new\n");

    const result = await loadBranchState();
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 4,
      deletions: 1,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("skips non-regular and binary untracked files without blocking", async () => {
    await initializeFeatureWork({ trackFeature: true });
    await writeFile("text.txt", "alpha\nbeta\n");
    await writeFile("blob.bin", Buffer.from([0x50, 0x00, 0x4b, 0x03]));
    if (process.platform !== "win32") {
      // A named pipe must not block the stats path until the git timeout.
      await execFileAsync("mkfifo", [path.join(root, "pipe")]);
    }

    const result = await loadBranchState();
    // 1 committed line + 2 untracked text lines; binary and pipe count 0.
    expect(result.branch).toMatchObject({ additions: 3, deletions: 0 });
  });

  it("omits the branch payload when the remote branch has nothing to compare", async () => {
    await initializeFeatureBranch();
    await trackRemote("feature");

    const result = await loadBranchState();
    // origin/feature == origin/main: GitHub would answer "nothing to compare".
    expect(result.branch).toBeUndefined();
  });

  it("reports local changes without createUrl until the branch exists on origin", async () => {
    await initializeFeatureBranch();
    await appendCommit("a.txt", "two\n", "local only");

    const result = await loadBranchState();
    // Unpushed branches have no GitHub pull/new page, but changed files still get a row.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("reports uncommitted changes when the remote branch has nothing to compare", async () => {
    await initializeFeatureBranch();
    await trackRemote("feature");
    await appendFile("a.txt", "pending\n");

    const result = await loadBranchState();
    // With equal remote refs, dirty work remains visible without a Create PR link.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("drops the Create PR row once the pushed tip is a merged PR's head", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    expect(result.pullRequests[0]?.state).toBe("merged");
    // A squash-merged remote tip must not resurrect a duplicate Create PR invitation.
    expect(result.branch).toBeUndefined();
  });

  it("sizes only post-merge work, without a create link, once the PR landed", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });
    await appendFile("a.txt", "follow-up\n");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Ignore the stale merged +1; only the uncommitted follow-up counts.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps the Create PR row when the PR merged into a non-default base", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });

    const result = await loadMergedBranchState(mergedHead, {
      base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    });
    // A release-branch merge leaves the default-branch Create PR available.
    expect(result.branch?.createUrl).toBe("https://github.com/openclaw/openclaw/pull/new/feature");
  });

  it("suppresses the row via local HEAD when the merged remote ref was pruned", async () => {
    // Model a merge-deleted head branch after its remote-tracking ref was pruned.
    const mergedHead = await initializeFeatureHead();

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Without this, the stale merge base replays the landed diff forever.
    expect(result.branch).toBeUndefined();
  });

  it("suppresses the row when the local checkout trails the merged remote tip", async () => {
    const staleHead = await initializeFeatureHead();
    // This checkout's HEAD trails the final commit pushed and merged elsewhere.
    await appendCommit("a.txt", "review fix\n", "review fix");
    await trackRemote("feature");
    const mergedHead = await resolveRevision("HEAD");
    await git("reset", "--hard", staleHead);

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // The clean, fully merged stale checkout must not replay a landed subset.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR for a branch rebased past the landing with new work", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false });
    // Reuse the branch after squash-landing it: reset to main, add work, and force-push.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");
    await writeCommit("b.txt", "second round\n", "second PR work");
    await trackRemote("feature");

    const result = await loadMergedBranchState(mergedHead, { merge_commit_sha: mergeCommit });
    // A merge base containing the landing proves this new commit is a second PR.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("counts a release-branch landing once its merge commit reaches main", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // The PR merged into a release branch whose squash later reached main.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "release merge propagated");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");

    const result = await loadMergedBranchState(mergedHead, {
      merge_commit_sha: mergeCommit,
      base: { ref: "release", repo: { name: "openclaw", owner: { login: "openclaw" } } },
    });
    // Once the release landing reaches main, its non-default base no longer matters.
    expect(result.branch).toBeUndefined();
  });

  it("restores Create PR atop a merge-commit landing without a rebase", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false });
    // A merge-commit landing keeps the head an ancestor of main.
    await git("checkout", "main");
    await git("merge", "--no-ff", "feature", "-m", "merge PR");
    const mergeCommit = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await writeCommit("b.txt", "follow-up\n", "follow-up work");
    await trackRemote("feature");

    const result = await loadMergedBranchState(mergedHead, { merge_commit_sha: mergeCommit });
    // The merge base contains the merged head, leaving only the follow-up to compare.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
      createUrl: "https://github.com/openclaw/openclaw/pull/new/feature",
    });
  });

  it("keeps Create PR off while a newer squash landing is unincorporated", async () => {
    // PR1: squash-land, then the branch rebases past it.
    const pr1Head = await initializeFeatureHead({ message: "pr1 work", trackMain: false });
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash pr1");
    const pr1Merge = await resolveRevision("HEAD");
    await git("checkout", "feature");
    await git("reset", "--hard", "main");
    // PR2 squash-lands, but the branch is not rebased again before its follow-up.
    await writeCommit("b.txt", "pr2\n", "pr2 work");
    const pr2Head = await resolveRevision("HEAD");
    await git("checkout", "main");
    await writeCommit("b.txt", "pr2\n", "squash pr2");
    const pr2Merge = await resolveRevision("HEAD");
    await trackRemote("main");
    await git("checkout", "feature");
    await writeCommit("c.txt", "follow-up\n", "follow-up work");
    await trackRemote("feature");

    const result = await loadBranchState({
      pullRequests: [
        mergedPull(pr2Head, {
          number: 2,
          merged_at: "2026-07-02T00:00:00Z",
          merge_commit_sha: pr2Merge,
        }),
        mergedPull(pr1Head, { number: 1, merge_commit_sha: pr1Merge }),
      ],
    });
    // Only PR1 is in the merge base, so show the follow-up but keep Create PR off.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("offers no Create PR from a stale tracking ref behind the merged head", async () => {
    const staleSha = await initializeFeatureHead();
    await appendCommit("a.txt", "final fix\n", "final fix");
    const mergedHead = await resolveRevision("HEAD");
    // This checkout's tracking ref and HEAD predate a final commit merged elsewhere.
    await trackRemote("feature", staleSha);
    await git("reset", "--hard", staleSha);

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // A stale ref is not new work when the merged head already contains it.
    expect(result.branch).toBeUndefined();
  });

  it("prefers the newer merge base after the default branch was merged back in", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // Main advances after the squash landing, then is merged back into the feature.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    await writeCommit("b.txt", "unrelated\n", "unrelated main work");
    await trackRemote("main");
    await git("checkout", "feature");
    await git("merge", "refs/remotes/origin/main", "-m", "merge main");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Main's merge-base tip carries the landing; the older head would replay its progress.
    expect(result.branch).toBeUndefined();
  });

  it("ignores the merged tip as a diff base when the branch was reset onto main", async () => {
    const mergedHead = await initializeFeatureHead({ trackMain: false, trackFeature: true });
    // Squash-land the same content on main, then main moves on.
    await git("checkout", "main");
    await appendCommit("a.txt", "two\n", "squash land");
    await writeCommit("b.txt", "unrelated\n", "unrelated main work");
    await trackRemote("main");
    // Reset the branch onto updated main while origin/feature stays on the merged head.
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // The merge base excludes unrelated main progress that a stale-tip diff would replay.
    expect(result.branch).toBeUndefined();
  });

  it("keeps post-merge commits as a stats-only row until the branch rebases", async () => {
    const mergedHead = await initializeFeatureHead({ trackFeature: true });
    await appendCommit("a.txt", "three\n", "post-merge work");
    await trackRemote("feature");

    const result = await loadBranchState({ pullRequests: [mergedPull(mergedHead)] });
    // Count the post-merge commit, but hide Create PR until the branch incorporates the landing.
    expect(result.branch).toEqual({
      owner: "openclaw",
      repo: "openclaw",
      branch: "feature",
      additions: 1,
      deletions: 0,
    });
  });

  it("omits the branch payload when the default branch is unknown", async () => {
    await initializeRepo();
    await git("checkout", "-b", "feature");
    await trackRemote("feature");

    const result = await loadBranchState({
      // No defaultBranch: origin/HEAD unresolvable in this checkout.
      defaultBranch: null,
    });
    // Fail closed: without a default branch there is nothing to compare against.
    expect(result.branch).toBeUndefined();
  });
});
