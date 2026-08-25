// Real-git boundary tests for the release-channel tag fetch in update-runner-git.
// The release fetch resolves its checkout tag after `git fetch`, so tags cannot be
// skipped (the dev channel uses `--no-tags`). An upstream-recreated (force-moved)
// tag makes a plain `--tags` fetch reject and exit non-zero, which aborted every
// `openclaw update` at fetch-failed. The release fetch is split into an unforced
// `--no-tags` branch fetch and a forced tag-only refspec so a recreated tag
// overwrites the local copy without forcing any configured branch mapping. These
// tests prove the git invariants at the real boundary, not behind a mock.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// Force the C locale so git's porcelain ref-status and error wording are stable
// across operator locales (CI runs C; dev machines may localize "would clobber").
const gitEnv = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv,
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function gitStatus(cwd: string, args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).status ?? 1;
}

describe("release-channel tag fetch tolerates upstream-recreated tags", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  // Bare origin whose tag `v1` is force-moved to a second commit, plus an operator
  // checkout still holding the stale first-tag object — the state an installed
  // `openclaw` checkout is in when upstream recreates a release tag.
  function setupRecreatedTagOrigin() {
    const root = tempDirs.make("openclaw-update-tags-");
    const origin = path.join(root, "origin.git");
    expect(spawnSync("git", ["init", "--bare", "-q", origin], { encoding: "utf8" }).status).toBe(0);

    const work = path.join(root, "work");
    expect(spawnSync("git", ["clone", "-q", origin, work], { encoding: "utf8" }).status).toBe(0);
    expect(gitStatus(work, ["config", "user.email", "t@t.t"])).toBe(0);
    expect(gitStatus(work, ["config", "user.name", "t"])).toBe(0);
    writeFileSync(path.join(work, "a.txt"), "A");
    expect(gitStatus(work, ["add", "-A"])).toBe(0);
    expect(gitStatus(work, ["commit", "-q", "-m", "A"])).toBe(0);
    expect(gitStatus(work, ["tag", "v1"])).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "push", "-q", "origin", "HEAD:main", "v1"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);

    // Operator checkout fetched the original tag object (prior `openclaw update`).
    const operator = path.join(root, "operator");
    expect(spawnSync("git", ["clone", "-q", origin, operator], { encoding: "utf8" }).status).toBe(
      0,
    );
    expect(gitStatus(operator, ["config", "user.email", "t@t.t"])).toBe(0);
    expect(gitStatus(operator, ["config", "user.name", "t"])).toBe(0);
    expect(git(operator, ["fetch", "-q", "--all", "--prune", "--tags"]).status).toBe(0);
    const firstTag = git(operator, ["rev-parse", "v1^{}"]).stdout.trim();

    // Upstream recreates: new commit, force-move v1 to it.
    writeFileSync(path.join(work, "b.txt"), "B");
    expect(gitStatus(work, ["add", "-A"])).toBe(0);
    expect(gitStatus(work, ["commit", "-q", "-m", "B"])).toBe(0);
    expect(gitStatus(work, ["tag", "-f", "v1"])).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "push", "-q", "--force", "origin", "HEAD:main", "v1"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    const recreatedTag = git(work, ["rev-parse", "v1^{}"]).stdout.trim();

    return { operator, firstTag, recreatedTag };
  }

  it("plain --tags fetch rejects a recreated tag and exits non-zero", () => {
    const { operator, firstTag, recreatedTag } = setupRecreatedTagOrigin();
    expect(firstTag).not.toBe(recreatedTag);

    const fetch = git(operator, ["fetch", "--all", "--prune", "--tags"]);
    expect(fetch.status).not.toBe(0);
    expect(fetch.stderr).toContain("would clobber existing tag");
    // Stale local tag object is unchanged after the rejected fetch.
    expect(git(operator, ["rev-parse", "v1^{}"]).stdout.trim()).toBe(firstTag);
  });

  it("two-step fetch overwrites the recreated tag and exits zero", () => {
    const { operator, recreatedTag } = setupRecreatedTagOrigin();

    // Release fetch is split: an unforced `--no-tags` branch fetch, then a per-remote
    // tag fetch whose `+` refspec prefix force-moves the recreated tag.
    const branchFetch = git(operator, ["fetch", "--all", "--prune", "--no-tags"]);
    expect(branchFetch.status, `${branchFetch.stdout}\n${branchFetch.stderr}`).toBe(0);
    const tagFetch = git(operator, ["fetch", "origin", "+refs/tags/*:refs/tags/*"]);
    expect(tagFetch.status, `${tagFetch.stdout}\n${tagFetch.stderr}`).toBe(0);
    expect(git(operator, ["rev-parse", "v1^{}"]).stdout.trim()).toBe(recreatedTag);
  });

  // Operator checkout with a protected (no `+` prefix) branch refspec, facing an
  // upstream that rewrites main non-fast-forward (rewind) and recreates the tag.
  function setupRewrittenBranchAndRecreatedTag() {
    const root = tempDirs.make("openclaw-update-ff-");
    const origin = path.join(root, "origin.git");
    expect(spawnSync("git", ["init", "--bare", "-q", origin], { encoding: "utf8" }).status).toBe(0);

    const work = path.join(root, "work");
    expect(spawnSync("git", ["clone", "-q", origin, work], { encoding: "utf8" }).status).toBe(0);
    expect(gitStatus(work, ["config", "user.email", "t@t.t"])).toBe(0);
    expect(gitStatus(work, ["config", "user.name", "t"])).toBe(0);
    // c1: main HEAD, tagged v1.
    writeFileSync(path.join(work, "a.txt"), "A");
    expect(gitStatus(work, ["add", "-A"])).toBe(0);
    expect(gitStatus(work, ["commit", "-q", "-m", "A"])).toBe(0);
    expect(gitStatus(work, ["branch", "-M", "main"])).toBe(0);
    expect(gitStatus(work, ["tag", "v1"])).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "push", "-q", "origin", "main", "v1"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    // c2: a second commit; main moves forward to c2, v1 stays on c1.
    writeFileSync(path.join(work, "b.txt"), "B");
    expect(gitStatus(work, ["add", "-A"])).toBe(0);
    expect(gitStatus(work, ["commit", "-q", "-m", "B"])).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "push", "-q", "origin", "main"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    const forwardMain = git(work, ["rev-parse", "main"]).stdout.trim();

    // Operator checkout with a PROTECTED branch refspec (no `+` prefix): a
    // non-fast-forward upstream rewrite must be rejected, not force-applied.
    const operator = path.join(root, "operator");
    expect(spawnSync("git", ["clone", "-q", origin, operator], { encoding: "utf8" }).status).toBe(
      0,
    );
    expect(gitStatus(operator, ["config", "user.email", "t@t.t"])).toBe(0);
    expect(gitStatus(operator, ["config", "user.name", "t"])).toBe(0);
    expect(
      gitStatus(operator, [
        "config",
        "remote.origin.fetch",
        "refs/heads/main:refs/remotes/origin/main",
      ]),
    ).toBe(0);
    expect(git(operator, ["fetch", "-q", "--all", "--prune"]).status).toBe(0);

    // Upstream REWRITES main non-fast-forward (rewind to c1) and recreates v1 on c2.
    expect(gitStatus(work, ["reset", "--hard", "HEAD~1"])).toBe(0);
    expect(gitStatus(work, ["tag", "-f", "v1", forwardMain])).toBe(0);
    expect(
      spawnSync("git", ["-C", work, "push", "-q", "--force", "origin", "main", "v1"], {
        encoding: "utf8",
      }).status,
    ).toBe(0);

    return {
      operator,
      forwardMain,
      rewoundMain: git(work, ["rev-parse", "main"]).stdout.trim(),
    };
  }

  it("tag-only force does not force-update a protected non-fast-forward branch refspec", () => {
    const { operator, forwardMain, rewoundMain } = setupRewrittenBranchAndRecreatedTag();
    // operator origin/main == forwardMain (c2); upstream rewound main to c1 (non-ff).
    expect(git(operator, ["rev-parse", "origin/main"]).stdout.trim()).toBe(forwardMain);
    expect(forwardMain).not.toBe(rewoundMain);

    // The two-step release fetch: branches unforced, then per-remote tag fetch
    // whose `+` refspec prefix forces tags without touching the branch mapping.
    const branchFetch = git(operator, ["fetch", "--all", "--prune", "--no-tags"]);
    expect(branchFetch.status).not.toBe(0); // rejected non-fast-forward
    // Protected branch refspec stays at the forward commit, not force-rewound.
    expect(git(operator, ["rev-parse", "origin/main"]).stdout.trim()).toBe(forwardMain);

    const tagFetch = git(operator, ["fetch", "origin", "+refs/tags/*:refs/tags/*"]);
    expect(tagFetch.status, `${tagFetch.stdout}\n${tagFetch.stderr}`).toBe(0);
    // Tag force-moved to the recreated target (c2); branch still untouched.
    expect(git(operator, ["rev-parse", "v1^{}"]).stdout.trim()).toBe(forwardMain);
    expect(git(operator, ["rev-parse", "origin/main"]).stdout.trim()).toBe(forwardMain);
  });
});
