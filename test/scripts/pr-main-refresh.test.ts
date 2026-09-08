import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const fixture = () => createMainRefreshFixture(tempDirs.make("openclaw-pr-main-refresh-"));

function recoverFixtureLock(f: ReturnType<typeof fixture>, oid: string) {
  const pgid = Number(/^pgid=(\d+)$/m.exec(f.git(f.canonical, "cat-file", "blob", oid))?.[1]);
  expect(pgid).toBeGreaterThan(1);
  expect(() => process.kill(-pgid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
  const result = f.run(["lock-recover", "42", oid, "--confirmed-no-running-tools"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(
    f.git(
      f.canonical,
      "for-each-ref",
      "--format=%(refname)",
      "refs/openclaw/pr-operation-locks/42",
    ),
  ).toBe("");
}

describePosix("native PR main refresh boundaries", () => {
  it.each(["detached", "pr-42", "pr-42-prep"])(
    "prepares directly from the reviewed head (%s) without visiting main",
    (branch) => {
      const f = fixture();
      f.git(f.canonical, "branch", "temp/pr-42", f.sameTreeHead);
      if (branch !== "detached") {
        f.git(f.worktree, "checkout", "-B", branch, f.head);
      }
      writeFileSync(join(f.canonical, "src/subject.ts"), "unrelated shared-checkout work\n");
      const sharedDiff = f.git(f.canonical, "diff", "HEAD");
      const review = readFileSync(join(f.local, "review.md"), "utf8");
      const result = f.run("prepare-init", "bash", f.worktree);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.git(f.worktree, "branch", "--show-current")).toBe("pr-42-prep");
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      expect(f.git(f.canonical, "rev-parse", "temp/pr-42")).toBe(f.sameTreeHead);
      expect(f.git(f.canonical, "diff", "HEAD")).toBe(sharedDiff);
      expect(readFileSync(join(f.local, "review.md"), "utf8")).toBe(review);
      expect(existsSync(join(f.local, "review-transition.json"))).toBe(false);
      const checkouts = f.events().filter((e) => e.args?.[0] === "checkout");
      expect(checkouts.length).toBeGreaterThan(0);
      expect(checkouts.every((e) => e.args?.at(-1) === f.head)).toBe(true);
      expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(1);
    },
  );

  it.each(["staged", "unstaged", "untracked", "unmerged"])(
    "refuses same-head preparation with %s foreign state",
    (state) => {
      const f = fixture();
      if (state === "unmerged") {
        expect(() => f.git(f.worktree, "merge", f.movedMain)).toThrow();
      } else {
        const path = state === "untracked" ? "foreign.txt" : "src/subject.ts";
        writeFileSync(join(f.worktree, path), "foreign data\n");
        if (state === "staged") {
          f.git(f.worktree, "add", path);
        }
      }
      const before = [
        f.git(f.worktree, "rev-parse", "HEAD"),
        f.git(f.worktree, "ls-files", "--stage"),
        f.git(f.worktree, "status", "--porcelain"),
        f.git(f.worktree, "diff", "HEAD"),
      ];
      const result = f.run("prepare-init");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("foreign state blocks a new transition");
      expect([
        f.git(f.worktree, "rev-parse", "HEAD"),
        f.git(f.worktree, "ls-files", "--stage"),
        f.git(f.worktree, "status", "--porcelain"),
        f.git(f.worktree, "diff", "HEAD"),
      ]).toEqual(before);
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
      expect(existsSync(join(f.local, "review-transition.json"))).toBe(false);
      expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    },
  );

  it.each(["detach", "fetch"])("recovers preparation after failed %s handoff", (failure) => {
    const f = fixture();
    f.git(f.worktree, "checkout", "-B", "pr-42", f.head);
    f.configure({ failDetach: failure === "detach", failPrFetch: failure === "fetch" });
    const failed = f.run("prepare-init");
    expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
    expect(failed.stderr).toContain("injected prepare handoff failure");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
    const journal = join(f.local, "review-transition.json");
    expect(existsSync(journal)).toBe(failure === "detach");
    if (failure === "detach") {
      expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({
        version: 1,
        pr: 42,
        source: f.head,
        target: f.head,
        mode: "detached",
        branch: null,
      });
    }
    const owner = f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42");
    expect(failed.stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
    recoverFixtureLock(f, owner);
    f.configure({ failDetach: false, failPrFetch: false });
    const result = f.run("prepare-init");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(f.worktree, "branch", "--show-current")).toBe("pr-42-prep");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(existsSync(journal)).toBe(false);
  });

  it("finishes an older main transition before rejecting a stale PR-head review", () => {
    const f = fixture();
    const journal = join(f.local, "review-transition.json");
    writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        pr: 42,
        source: f.head,
        target: f.main,
        mode: "detached",
        branch: null,
      }),
    );
    f.git(
      f.worktree,
      "restore",
      `--source=${f.main}`,
      "--staged",
      "--worktree",
      "--",
      "src/subject.ts",
    );
    const result = f.run("prepare-init");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout).toContain("expected HEAD at PR_HEAD_SHA");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
  });

  it("completes supervised prepare with three fresh checkpoints and exact stamps", () => {
    const f = fixture();
    const result = f.run("prepare-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("prepare-run complete for PR #42");
    expect(result.stdout).toContain("Remote branch already at local prep HEAD; skipping push.");
    expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(3);
    const stamp = readFileSync(join(f.local, "prep.env"), "utf8");
    expect(stamp).toContain(`PREP_HEAD_SHA=${f.head}\n`);
    expect(stamp).toContain(`LOCAL_PREP_HEAD_SHA=${f.head}\n`);
    expect(stamp).toContain(`PREP_MAINLINE_BASE_SHA=${f.main}\n`);
    expect(stamp).toContain("PREP_REPLACED_HOSTED_ANCESTRY=false\n");
    expect(stamp).toContain("PREP_AUTHOR_ACCESS=maintainer\n");
    expect(readFileSync(join(f.local, "prep-context.env"), "utf8")).toContain(
      "PR_AUTHOR_ACCESS_AT_PREP=maintainer\n",
    );
    expect(
      f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
    ).toBe("");
    expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
    const lockWrites = f
      .events()
      .filter(
        (e) => e.kind === "git-decision" && e.args?.includes("refs/openclaw/pr-operation-locks/42"),
      );
    expect(lockWrites).toHaveLength(2);
    expect(lockWrites[1]?.args?.at(-1)).toBe(lockWrites[0]?.args?.at(-2));
  });

  it("retains the publication receipt and operation lock on mismatched receipt ownership", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    const receiptPath = join(f.local, "prep.env");
    const receipt = readFileSync(receiptPath, "utf8").replace("PR_NUMBER=42\n", "PR_NUMBER=43\n");
    writeFileSync(receiptPath, receipt);
    const result = f.run("prepare-sync-head");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("Retaining the operation lock for PR #42");
    expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(f.head);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
  });

  it("retires prior publication evidence only after a fresh reviewed preparation", () => {
    const f = fixture();
    const firstPrepare = f.run("prepare-run");
    expect(firstPrepare.status, firstPrepare.stdout + firstPrepare.stderr).toBe(0);
    f.git(f.worktree, "commit", "--allow-empty", "-qm", "reviewed fixup");
    const published = f.git(f.worktree, "rev-parse", "HEAD");
    const gitShim = join(f.root, "bin", "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const updateMetadata = [
      'const fs = require("node:fs")',
      "const file = process.argv[1]",
      'const control = JSON.parse(fs.readFileSync(file, "utf8"))',
      "control.metadata.headRefOid = process.argv[2]",
      "fs.writeFileSync(file, JSON.stringify(control))",
    ].join(";");
    // Allow exactly this publication through real Git, then expose its new
    // PR ref and metadata through the existing synthetic GitHub boundary.
    writeFileSync(
      gitShim,
      `#!/bin/sh
if [ "$1" = push ] && [ "$2" = "--force-with-lease=refs/heads/topic:${f.head}" ] && [ "$4" = "${published}:refs/heads/topic" ]; then
  "${realGit}" "$@" || exit "$?"
  "${realGit}" -C "${f.origin}" update-ref refs/pull/42/head "${published}" || exit "$?"
  "${process.execPath}" -e '${updateMetadata}' "${join(f.root, "control.json")}" "${published}"
  exit "$?"
fi
${readFileSync(gitShim, "utf8")}
`,
    );
    f.env.OPENCLAW_PR_PUSH_MODE = "git";
    f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "1";
    const firstPublish = f.run("prepare-sync-head");
    expect(firstPublish.status, firstPublish.stdout + firstPublish.stderr).toBe(0);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(published);
    const artifacts = [
      "prep-context.env",
      "prep.env",
      "gates.env",
      "prepare-push-result.env",
      "prepare-sync-result.env",
      "prep.md",
    ];
    const priorEvidence = artifacts.map(
      (name) => [name, readFileSync(join(f.local, name), "utf8")] as const,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE=${f.head}\n`,
    );

    f.git(f.worktree, "commit", "--allow-empty", "-qm", "new contribution to review");
    const reviewed = f.git(f.worktree, "rev-parse", "HEAD");
    f.git(
      f.worktree,
      "push",
      "origin",
      `${reviewed}:refs/heads/topic`,
      `${reviewed}:refs/pull/42/head`,
    );
    f.configure({ metadata: { ...f.metadata, headRefOid: reviewed } });
    for (const command of ["review-init", "review-checkout-pr"]) {
      const result = f.run(command);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    for (const name of ["review.md", "review.json"]) {
      const path = join(f.local, name);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.head, reviewed));
    }
    const nextPrepare = f.run("prepare-run");
    expect(nextPrepare.status, nextPrepare.stdout + nextPrepare.stderr).toBe(0);
    expect(readFileSync(join(f.local, "prep-context.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE=${reviewed}\n`,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PREP_HEAD_SHA=${reviewed}\n`,
    );
    const retained = readdirSync(f.local).filter((name) => name.startsWith("prep-evidence."));
    expect(retained).toHaveLength(1);
    for (const directory of retained) {
      for (const [name, contents] of priorEvidence) {
        expect(readFileSync(join(f.local, directory, name), "utf8")).toBe(contents);
      }
    }
    const sync = f.run("prepare-sync-head");
    expect(sync.status, sync.stdout + sync.stderr).toBe(0);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(reviewed);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
  });

  it("completes supervised merge with two checkpoints and releases its exact lock after cleanup", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    const before = f.events().length;
    const result = f.run("merge-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("merge-run complete for PR #42");
    const landed = f.git(f.origin, "rev-parse", "refs/heads/main");
    expect(
      JSON.parse(f.git(f.canonical, "show", "refs/openclaw/pr-merge-outcomes/42:outcome.json")),
    ).toMatchObject({ phase: "complete", head: f.head, main: f.main, landed });
    expect(f.git(f.canonical, "rev-parse", `${landed}^{tree}`)).toBe(
      f.git(f.canonical, "rev-parse", `${f.head}^{tree}`),
    );
    expect(f.events().filter((e) => e.kind === "leased-cleanup")).toHaveLength(1);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
    expect(
      f
        .events()
        .slice(before)
        .filter((e) => e.kind === "main-fetch"),
    ).toHaveLength(2);
    expect(existsSync(f.worktree)).toBe(false);
    expect(
      f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
    ).toBe("");
  });

  it.each([2, 3])(
    "retains the operation lock when checkpoint %s fails after preparation mutated state",
    (checkpoint) => {
      const f = fixture();
      f.configure({ failFetchAt: checkpoint });
      const result = f.run("prepare-run");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Retaining the operation lock for PR #42");
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(true);
      expect(existsSync(join(f.local, "gates.env"))).toBe(checkpoint === 3);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(checkpoint);
      expect(
        f.git(
          f.canonical,
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/pr-operation-locks",
        ),
      ).toBe("refs/openclaw/pr-operation-locks/42");
    },
  );

  it("refreshes gate and publication snapshots when a newly reviewed head rebuilds preparation", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    f.configure({ metadata: { ...f.metadata, headRefOid: f.sameTreeHead } });
    f.git(
      f.canonical,
      "push",
      "origin",
      `${f.sameTreeHead}:refs/heads/topic`,
      `${f.sameTreeHead}:refs/pull/42/head`,
    );
    f.git(f.worktree, "fetch", "origin", "refs/pull/42/head:refs/heads/pr-42");
    for (const artifact of ["pr-meta.env", "pr-meta.json", "review.json", "review.md"]) {
      const path = join(f.local, artifact);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.head, f.sameTreeHead));
    }
    const before = f.events().length;
    const result = f.run("prepare-push");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("rerunning prepare gates before push");
    expect(
      f
        .events()
        .slice(before)
        .filter((e) => e.kind === "main-fetch"),
    ).toHaveLength(3);
    expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
      `HOSTED_GATES_TARGET_HEAD_SHA=${f.sameTreeHead}\n`,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PREP_HEAD_SHA=${f.sameTreeHead}\n`,
    );
  });

  it("keeps nested preparation coherent and refreshes after hosted gates", () => {
    const f = fixture();
    f.configure({ moveAfterFirstFetch: true, moveAtGate: true });
    const result = f.run("prepare-run", "bash", f.worktree);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain, f.gateMain]);
    const decisions = f
      .events()
      .filter((e) => e.kind === "git-decision")
      .map((e) => e.args?.join(" "));
    expect(decisions).toContain(`diff --name-only ${f.movedMain}...HEAD`);
    expect(decisions).toContain(`merge-base ${f.head} ${f.gateMain}`);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("keeps hosted membership on the gate snapshot when the API base advances only in the remote", () => {
    const f = fixture();
    const remoteOnlyBase = f.git(
      f.origin,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      `${f.main}^{tree}`,
      "-p",
      f.main,
      "-m",
      "test: remote-only main advancement",
    );
    f.configure({ remoteOnlyBase });
    const result = f.run("prepare-run");
    const events = f.events();
    const baseRead = events.findIndex((e) => e.kind === "remote-only-base");
    expect(events[baseRead]).toEqual({
      kind: "remote-only-base",
      sha: remoteOnlyBase,
      localObject: false,
    });
    expect(
      events
        .slice(0, baseRead)
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.main]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events.filter((e) => e.kind === "fetched").map((e) => e.sha)).toEqual([
      f.main,
      f.main,
      remoteOnlyBase,
    ]);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(`PREP_HEAD_SHA=${f.head}\n`);
  });

  it("captures private FETCH_HEAD despite a competing shared-ref write and worktree origin/refmap overrides", () => {
    const f = fixture();
    f.git(f.canonical, "remote", "set-url", "origin", "../origin.git");
    f.git(f.worktree, "config", "--worktree", "remote.origin.url", join(f.root, "wrong-origin"));
    f.git(
      f.worktree,
      "config",
      "--worktree",
      "remote.origin.fetch",
      "+refs/heads/movement:refs/remotes/origin/main",
    );
    f.git(f.canonical, "update-ref", "refs/heads/origin/main", f.movedMain);
    f.configure({ moveSharedAfterFetch: true });
    const result = f.run("review-checkout-main");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
    expect(f.events().filter((e) => e.kind === "fetched")).toEqual([
      { kind: "fetched", sha: f.main, shared: f.movedMain },
    ]);
    expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(f.movedMain);
  });

  it("starts a new operation fresh and rejects a stale detached main review", () => {
    const f = fixture();
    expect(f.run("review-checkout-main").status).toBe(0);
    f.git(f.origin, "update-ref", "refs/heads/main", f.movedMain);
    const result = f.run("review-guard");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout).toContain(`expected HEAD at origin/main (${f.movedMain})`);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
  });

  it("preserves foreign checkout-hook changes when cold review initialization requests a reset", () => {
    const f = fixture();
    f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
    const hooks = join(f.canonical, ".git", "hooks");
    writeFileSync(
      join(hooks, "post-checkout"),
      "#!/bin/sh\nprintf 'foreign checkout-hook change\\n' > src/subject.ts\n",
      { mode: 0o755 },
    );
    f.git(f.canonical, "config", "core.hooksPath", hooks);
    const result = f.run("review-init");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("foreign state blocks a new transition");
    expect(f.git(f.worktree, "status", "--short")).toBe("M src/subject.ts");
    expect(readFileSync(join(f.worktree, "src/subject.ts"), "utf8")).toBe(
      "foreign checkout-hook change\n",
    );
    expect(f.git(f.canonical, "status", "--short")).toBe("");
  });

  it("uses the private checkpoint after an uninterrupted cold bootstrap while main moves", () => {
    const f = fixture();
    f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
    f.git(f.canonical, "checkout", "--detach", f.head);
    f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
    f.configure({ moveAfterFirstFetch: true });
    const result = f.run("review-checkout-main");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain]);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.head);
  });

  it.each([1, 2])(
    "provisions without a local main anchor and retries cold fetch %s failure",
    (fetchNumber) => {
      const f = fixture();
      f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
      f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
      f.configure({ failFetchAt: fetchNumber });
      const failed = f.run("review-checkout-main");
      expect(failed.status).not.toBe(0);
      expect(existsSync(f.worktree)).toBe(fetchNumber === 2);
      if (fetchNumber === 2) {
        expect(f.git(f.worktree, "write-tree")).toBe(
          f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
        );
        expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      }
      const owner = f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42");
      expect(failed.stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
      recoverFixtureLock(f, owner);
      f.configure({ failFetchAt: 0 });
      const result = f.run("review-checkout-main");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
      expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    },
  );

  it("invalidates the previous snapshot when the same operation provisions a new worktree", () => {
    const f = fixture();
    f.configure({ moveAfterFirstFetch: true });
    const result = f.shell(`
enter_worktree 42 false
printf 'first=%s\\n' "$PR_MAIN_SHA"
cd "$(repo_root)"
git worktree remove --force .worktrees/pr-42
enter_worktree 42 false
printf 'replacement=%s\\n' "$PR_MAIN_SHA"
`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`first=${f.main}\n`);
    expect(result.stdout).toContain(`replacement=${f.movedMain}\n`);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain, f.movedMain]);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
  });

  it.each([
    { phase: "bootstrap", fetchNumber: 1 },
    { phase: "private", fetchNumber: 2 },
  ])(
    "recovers cold $phase fetch interruption through the native exact owner",
    async ({ fetchNumber }) => {
      const f = fixture();
      f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
      f.git(f.canonical, "checkout", "--detach", f.head);
      f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
      f.git(f.canonical, "update-ref", "refs/heads/origin/main", f.head);
      const readyPath = join(f.root, "fetch-ready.fifo");
      const holdPath = join(f.root, "fetch-hold.fifo");
      execFileSync("mkfifo", [readyPath, holdPath]);
      f.env.OPENCLAW_TEST_FETCH_READY = readyPath;
      f.env.OPENCLAW_TEST_FETCH_HOLD = holdPath;
      writeFileSync(
        join(f.root, "hold-upload-pack"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$$" "$(ps -o pgid= -p "$$")" > "$OPENCLAW_TEST_FETCH_READY"
read -r release < "$OPENCLAW_TEST_FETCH_HOLD"
`,
        { mode: 0o755 },
      );
      f.configure({ pauseFetchAt: fetchNumber });
      const reader = createReadStream(readyPath, { encoding: "utf8" });
      const ready = new Promise<string>((resolve, reject) => {
        let data = "";
        reader.on("data", (chunk) => {
          data += chunk.toString();
          const newline = data.indexOf("\n");
          if (newline >= 0) {
            resolve(data.slice(0, newline));
          }
        });
        reader.once("error", reject);
      });
      const controller = spawn(
        "bash",
        [join(f.canonical, "scripts/pr"), "review-checkout-main", "42"],
        {
          cwd: f.canonical,
          env: f.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      controller.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      controller.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        controller.once("error", reject);
        controller.once("close", resolve);
      });
      const lockRef = "refs/openclaw/pr-operation-locks/42";
      const ownerFields = (oid: string) =>
        Object.fromEntries(
          f
            .git(f.canonical, "cat-file", "blob", oid)
            .split("\n")
            .map((line) => line.split("=")),
        );
      try {
        const handshake = await Promise.race([
          ready,
          exited.then((code) => {
            throw new Error(`Exited before fetch readiness: ${code}\n${stdout}${stderr}`);
          }),
        ]);
        const [uploadPid, uploadPgid] = handshake.split("\t").map(Number);
        const owner = f.git(f.canonical, "rev-parse", lockRef);
        const fields = ownerFields(owner);
        expect(uploadPid).toBeGreaterThan(1);
        expect(Number(fields.supervisor_pid)).toBe(controller.pid);
        expect(Number(fields.pgid)).toBe(uploadPgid);
        const initializedTree = existsSync(f.worktree)
          ? f.git(f.worktree, "write-tree")
          : undefined;
        const indexExists =
          existsSync(f.worktree) &&
          existsSync(join(f.git(f.worktree, "rev-parse", "--absolute-git-dir"), "index"));
        f.git(f.origin, "update-ref", "refs/heads/main", f.movedMain);
        controller.kill("SIGTERM");
        expect(await exited, stdout + stderr).toBe(143);
        expect(f.git(f.canonical, "rev-parse", lockRef)).toBe(owner);
        expect(stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
        recoverFixtureLock(f, owner);
        f.configure({ pauseFetchAt: 0 });
        const retry = f.run("review-checkout-main");
        const retryOwner = f.git(f.canonical, "for-each-ref", "--format=%(objectname)", lockRef);
        if (retryOwner) {
          recoverFixtureLock(f, retryOwner);
        }
        expect(retry.status, retry.stdout + retry.stderr).toBe(0);
        expect(initializedTree).toBe(
          fetchNumber === 1 ? undefined : f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
        );
        expect(indexExists).toBe(fetchNumber === 2);
        expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
        expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
        expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.head);
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) {
          controller.kill("SIGTERM");
        }
        await exited;
        // Unblock a pending FIFO open/read even if the wrapper exited before the handshake.
        const fd = openSync(readyPath, constants.O_RDWR);
        writeSync(fd, "\n");
        closeSync(fd);
        reader.destroy();
      }
    },
  );

  it.each(["metadata", "fetched", "branch"] as const)(
    "rejects changed exact PR identity at %s before preparation stamps",
    (boundary) => {
      const f = fixture();
      expect(f.git(f.canonical, "rev-parse", `${f.head}^{tree}`)).toBe(
        f.git(f.canonical, "rev-parse", `${f.sameTreeHead}^{tree}`),
      );
      if (boundary === "metadata") {
        f.configure({ metadata: { ...f.metadata, headRefOid: f.sameTreeHead } });
      }
      if (boundary === "branch") {
        f.configure({ metadata: { ...f.metadata, headRefName: "renamed" } });
      }
      if (boundary === "fetched") {
        f.git(f.canonical, "push", "origin", `${f.sameTreeHead}:refs/pull/42/head`);
      }
      const result = f.run("prepare-run");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout).toContain(
        boundary === "branch" ? "PR head branch changed" : "PR head changed",
      );
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      expect(f.events().some((e) => e.kind === "hosted-gate")).toBe(false);
    },
  );

  it.each([false, true])(
    "refreshes after CI and required checks with strict drift=%s",
    (strict) => {
      const f = fixture();
      const prepare = f.run("prepare-run");
      expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
      // This case owns the nonhosted watcher's post-wait refresh contract.
      writeFileSync(join(f.local, "gates.env"), "GATES_MODE=full\n");
      f.configure({ moveAtCi: true });
      if (strict) {
        f.env.OPENCLAW_PR_STRICT_DRIFT = "1";
      }
      const before = f.events().length;
      const result = f.run("merge-verify");
      expect(result.status, result.stdout + result.stderr).toBe(strict ? 1 : 0);
      expect(result.stdout).toContain(
        strict ? "Merge verify failed: mainline drift" : "WARNING — mainline drift",
      );
      const events = f.events().slice(before);
      expect(events.filter((e) => e.kind === "fetched").map((e) => e.sha)).toEqual([
        f.main,
        f.movedMain,
      ]);
      const checks = events.findIndex((e) => e.kind === "required-checks");
      expect(events.findIndex((e) => e.kind === "ci-completed")).toBeLessThan(checks);
      expect(events.findLastIndex((e) => e.kind === "main-fetch")).toBeGreaterThan(checks);
    },
  );

  it("rejects a moved prepared branch without consuming CI proof", () => {
    const f = fixture();
    expect(f.run("prepare-run").status).toBe(0);
    const stamp = readFileSync(join(f.local, "prep.env"), "utf8");
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", f.sameTreeHead);
    const result = f.run("merge-verify");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Local prep branch moved after prepare-push");
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(stamp);
    expect(f.events().some((e) => e.kind === "ci-completed")).toBe(false);
  });

  it("invalidates a previous snapshot when the next checkpoint fails", () => {
    const f = fixture();
    f.configure({ failFetchAt: 2 });
    const result = f.shell(
      'enter_worktree 42 false\nif refresh_main_snapshot; then exit 99; fi\nprintf "snapshot=%s\\n" "$PR_MAIN_SHA"',
      "/bin/bash",
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("snapshot=\n");
    expect(f.events().filter((e) => e.kind === "fetched")).toHaveLength(1);
  });

  it("propagates authentication failure under an OR-list before any main fetch", () => {
    const f = fixture();
    f.configure({ failAuth: true });
    const result = f.shell(
      "review_validate_artifacts 42 || exit 1\necho UNEXPECTED_SUCCESS",
      "/bin/bash",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub API preflight failed");
    expect(f.events().some((e) => e.kind === "main-fetch")).toBe(false);
  });

  it("stops native merge on viewer quota failure before fetch or dispatch and releases its lock", () => {
    const f = fixture();
    f.configure({ viewerRateLimited: true });
    const result = f.run("merge-run");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("GitHub API preflight rate limited");
    expect(f.events().some((e) => e.kind === "main-fetch")).toBe(false);
    const ghCalls = f.events().filter((e) => e.kind === "gh");
    expect(ghCalls.at(-1)?.args).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query { viewer { login } }",
      "--include",
    ]);
    expect(ghCalls.some((e) => e.args?.includes("merge"))).toBe(false);
    expect(f.git(f.origin, "rev-parse", "refs/heads/main")).toBe(f.main);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw")).toBe("");
  });

  for (const bash of ["bash", ...(process.platform === "darwin" ? ["/bin/bash"] : [])]) {
    for (const command of [
      "enter_worktree 42 false",
      "review_guard 42",
      "review_validate_artifacts 42",
    ]) {
      it.each([false, true])(
        `propagates failed refresh through ${command} in ${bash} (OR-list=%s)`,
        (orList) => {
          const f = fixture();
          f.configure({ failFetch: true });
          const result = f.shell(
            `${command}${orList ? " || exit 1" : ""}\necho UNEXPECTED_SUCCESS`,
            bash,
          );
          expect(result.stderr).toContain("injected main fetch failure");
          expect(result.status, result.stdout + result.stderr).not.toBe(0);
          expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
          expect(result.stdout).not.toContain("review artifacts validated");
          expect(existsSync(join(f.local, "prep.env"))).toBe(false);
        },
      );
    }
  }
});
