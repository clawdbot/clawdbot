import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources } from "./pr-wrapper.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const outcomeRef = "refs/openclaw/pr-merge-outcomes/123";
const lockRef = "refs/openclaw/pr-operation-locks/123";
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const root = realpathSync(temps.make("pr-cross-checkout-"));
  const owner = join(root, "owner");
  const caller = join(root, "caller");
  const bin = join(root, "bin");
  for (const dir of [owner, caller, bin]) {
    mkdirSync(dir);
  }
  // Recovery and metadata checks need these preflight commands but must never execute them.
  for (const command of ["rg", "pnpm"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\necho 'Unexpected fixture command: ${command}' >&2\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    HOME: root,
    TMPDIR: root,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
  const git = (repo: string, args: string[], input?: string) =>
    execFileSync("git", ["-C", repo, ...args], {
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  for (const repo of [owner, caller]) {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Fixture"]);
    git(repo, ["config", "user.email", "fixture@example.invalid"]);
    git(repo, ["config", "core.hooksPath", "/dev/null"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    git(repo, ["commit", "--allow-empty", "-qm", "Base"]);
  }
  copyPrWrapperSources(owner);
  const base = git(owner, ["rev-parse", "HEAD"]);
  const blob = git(owner, ["hash-object", "-w", "--stdin"], "reviewed change\n");
  const tree = git(owner, ["mktree"], `100644 blob ${blob}\towner.txt\n`);
  const head = git(owner, ["commit-tree", tree, "-p", base], "Source\n");
  const landed = git(owner, ["commit-tree", tree, "-p", base], "Landed\n");
  git(owner, ["update-ref", "refs/heads/main", landed]);
  git(owner, ["remote", "add", "origin", owner]);
  const worktree = join(owner, ".worktrees/pr-123");
  git(owner, ["worktree", "add", "-q", "--detach", worktree, head]);
  mkdirSync(join(worktree, ".local"));
  const capture = join(worktree, ".local/merge-output.log");
  writeFileSync(capture, "retained capture\n");
  const repo = { id: 123, nameWithOwner: "fixture/repo", url: "https://github.com/fixture/repo" };
  const record = {
    version: 1,
    repo,
    pr: 123,
    prId: "fixture-pr",
    base: "main",
    head,
    main: base,
    method: "squash",
    route: "immediate",
    attempt: "11111111-2222-4333-8444-555555555555",
    phase: "intent",
    accepted: true,
    landed: null,
  };
  const recordBlob = git(owner, ["hash-object", "-w", "--stdin"], JSON.stringify(record));
  const recordTree = git(owner, ["mktree"], `100644 blob ${recordBlob}\toutcome.json\n`);
  const intent = git(owner, ["commit-tree", recordTree, "-p", head, "-p", base], "Intent\n");
  git(owner, ["update-ref", outcomeRef, intent]);
  const response = {
    data: {
      repository: {
        ...repo,
        ref: { target: { oid: landed } },
        pullRequest: {
          id: record.prId,
          number: 123,
          url: `${repo.url}/pull/123`,
          state: "MERGED",
          headRefOid: head,
          baseRefName: "main",
          isDraft: false,
          mergeCommit: { oid: landed },
          autoMergeRequest: null,
          isInMergeQueue: false,
          isMergeQueueEnabled: false,
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
        },
      },
    },
  };
  const calls = join(root, "calls.log");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\t%s\\n' "$(git rev-parse --show-toplevel)" "$*" >> '${calls}'
case "$1 $2" in
  "repo view") printf '%s\\n' '${JSON.stringify(repo)}' ;;
  "api graphql") printf '%s\\n' '${JSON.stringify(response)}' ;;
  "pr view")
    if [ "$(git rev-parse --show-toplevel)" = '${owner}' ]; then
      printf '%s\\n' '{"baseRefName":"owner-release","headRefOid":""}'
    else
      printf '%s\\n' '{"baseRefName":"caller-release","headRefOid":""}'
    fi ;;
  *) echo "Unexpected GitHub operation: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const run = (cwd = caller, args = ["merge-run", "123"]) => {
    const result = spawnSync(join(owner, "scripts/pr"), args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const readCalls = () => readFileSync(calls, "utf8").trim().split("\n");
  return {
    root,
    owner,
    caller,
    worktree,
    capture,
    head,
    landed,
    intent,
    record,
    git,
    run,
    readCalls,
  };
}

describePosix("native PR wrapper repository ownership", () => {
  it.each(["foreign", "foreign with outcome", "linked", "non-Git"])(
    "reconciles the owner's accepted intent from a %s caller without redispatch or cleanup",
    (location) => {
      const f = fixture();
      let cwd = f.caller;
      if (location === "foreign with outcome") {
        // A same-number record in another clone must never become recovery authority.
        f.git(f.caller, ["update-ref", outcomeRef, f.git(f.caller, ["rev-parse", "HEAD"])]);
      } else if (location === "linked") {
        cwd = f.worktree;
      } else if (location === "non-Git") {
        cwd = f.root;
      }
      const callerRefs = f.git(f.caller, ["show-ref"]);
      const result = f.run(cwd);

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`MERGED exact attempted head ${f.head} as ${f.landed}`);
      expect(result.output).toContain("completion pending");
      expect(JSON.parse(f.git(f.owner, ["show", `${outcomeRef}:outcome.json`]))).toEqual({
        ...f.record,
        phase: "merged",
        landed: f.landed,
      });
      f.git(f.owner, ["merge-base", "--is-ancestor", f.intent, outcomeRef]);
      expect(readFileSync(f.capture, "utf8")).toBe("retained capture\n");
      expect(f.git(f.caller, ["show-ref"])).toBe(callerRefs);
      expect(f.git(f.owner, ["for-each-ref", "--format=%(refname)", lockRef])).toBe("");
      expect(f.readCalls()).toHaveLength(3);
      expect(f.readCalls().every((call) => call.startsWith(`${f.owner}\t`))).toBe(true);
      expect(f.readCalls().some((call) => call.includes("pr merge") || call.includes("POST"))).toBe(
        false,
      );
    },
  );

  it("reconciles from another clone after the disposable worktree is gone", () => {
    const f = fixture();
    f.git(f.owner, ["worktree", "remove", "--force", f.worktree]);
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("completion pending");
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.git(f.caller, ["for-each-ref", "--format=%(refname)", "refs/openclaw"])).toBe("");
  });

  it("rejects corrupt owner evidence even when the caller has a valid retained intent", () => {
    const f = fixture();
    f.git(f.caller, ["fetch", f.owner, `${outcomeRef}:${outcomeRef}`]);
    f.git(f.owner, ["update-ref", outcomeRef, f.head]);
    const result = f.run();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("corrupt or mismatched retained record");
    expect(f.git(f.owner, ["rev-parse", outcomeRef])).toBe(f.head);
    expect(f.git(f.caller, ["rev-parse", outcomeRef])).toBe(f.intent);
    expect(readFileSync(f.capture, "utf8")).toBe("retained capture\n");
    expect(f.readCalls()).toEqual([`${f.owner}\trepo view --json id,nameWithOwner,url`]);
  });

  it.each(["prepare-run", "merge-recover", "ci-dispatch", "review-init"])(
    "uses owner repository metadata for early %s validation",
    (command) => {
      const f = fixture();
      const result = f.run(f.caller, [
        command,
        "123",
        ...(command === "merge-recover" ? [f.intent, "--confirmed-operator-recovery"] : []),
      ]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        command === "ci-dispatch"
          ? "missing remote headRefName/headRefOid metadata"
          : command === "review-init"
            ? "did not include a head SHA"
            : "targets owner-release",
      );
      expect(f.readCalls()).toHaveLength(1);
      expect(f.readCalls()[0]).toContain(`${f.owner}\tpr view 123 --json `);
      expect(f.git(f.owner, ["rev-parse", outcomeRef])).toBe(f.intent);
      expect(f.git(f.owner, ["for-each-ref", "--format=%(refname)", lockRef])).toBe("");
      expect(f.git(f.caller, ["for-each-ref", "--format=%(refname)", "refs/openclaw"])).toBe("");
    },
  );
});
