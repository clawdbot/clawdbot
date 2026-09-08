import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as processExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { resolveWorktreeBase } from "./base-ref.js";
import {
  commandError,
  findGitCheckoutRoot,
  gitEnvironment,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
  listGitWorktrees,
  requireGit,
  runGit,
} from "./git.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Git ref mutation ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const snapshotRef = "refs/openclaw/snapshots/held";
  const queuedRef = "refs/openclaw/snapshots/queued";

  async function repository() {
    const root = tempDirs.make("openclaw-git-ref-");
    await requireGit(root, ["init", "--quiet", "-b", "main"]);
    await requireGit(root, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    await requireGit(root, ["update-ref", snapshotRef, "HEAD"]);
    await requireGit(root, ["update-ref", queuedRef, "HEAD"]);
    return root;
  }

  it("rejects incomplete required stdout through the worktree wrapper", async () => {
    const root = await repository();
    const input = Buffer.alloc(17 * 1024 * 1024, "x");
    const oid = await requireGit(root, ["hash-object", "-w", "--stdin"], { input });
    const outcome = await requireGit(root, ["cat-file", "blob", oid]).then(
      () => "returned incomplete output",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toContain("output limit exceeded");
  });

  function holdSnapshotDeletion(failure?: Error, discoverySignal?: AbortSignal) {
    const started = createDeferred();
    const release = createDeferred();
    const discovered = createDeferred<SpawnResult>();
    const mutations: Array<{ cwd: string; args: string[] }> = [];
    const run = processExec.runCommandWithTimeout;
    let held = false;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const args = argv.slice(3);
      if (args[0] === "update-ref" || (args[0] === "branch" && args[1] === "-D")) {
        mutations.push({ cwd: argv[2]!, args });
        if (!held && args[0] === "update-ref" && args[2] === snapshotRef) {
          held = true;
          started.resolve();
          await release.promise;
          if (failure) {
            throw failure;
          }
        }
      }
      const result = await run(argv, options);
      if (
        discoverySignal &&
        typeof options !== "number" &&
        options.signal === discoverySignal &&
        args[0] === "rev-parse" &&
        args[1] === "--git-common-dir"
      ) {
        discovered.resolve(result);
      }
      return result;
    });
    return { started, release, discovered, mutations };
  }

  it("rejects cancelled discovery with exit code zero without deleting the requested ref", async () => {
    const root = await repository();
    const commandSpy = vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce({
      stdout: ".git\n",
      stderr: "",
      code: 0,
      signal: null,
      termination: "signal",
      killed: false,
    });

    await expect(requireGit(root, ["update-ref", "-d", queuedRef])).rejects.toThrow(
      `git update-ref -d ${queuedRef} failed (terminated):\n.git`,
    );
    expect(commandSpy.mock.calls.map(([argv]) => argv.slice(3))).toEqual([
      ["rev-parse", "--git-common-dir"],
    ]);
    expect(await requireGit(root, ["show-ref", "--verify", queuedRef])).toContain(queuedRef);
  });

  it.runIf(process.platform === "win32")(
    "normalizes MSYS common-directory output while preserving a literal revision mutation",
    async () => {
      const root = await repository();
      const commonDir = await fs.realpath(path.join(root, ".git"));
      expect(commonDir).toMatch(/^[a-zA-Z]:[\\/]/u);
      const msysCommonDir = `/${commonDir[0]!.toLowerCase()}${commonDir.slice(2).replaceAll("\\", "/")}`;
      const run = processExec.runCommandWithTimeout;
      let discoveries = 0;
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await run(argv, options);
        if (argv[3] === "rev-parse" && argv[4] === "--git-common-dir") {
          discoveries += 1;
          return { ...result, stdout: `${msysCommonDir}\n` };
        }
        return result;
      });
      await requireGit(root, ["update-ref", queuedRef, "HEAD^{commit}"], {
        env: { MSYS: "winsymlinks:nativestrict", CYGWIN: "disable_pcon" },
      });
      expect(discoveries).toBe(1);
      expect(await requireGit(root, ["rev-parse", queuedRef])).toBe(
        await requireGit(root, ["rev-parse", "HEAD"]),
      );
    },
  );

  it("serializes snapshot and branch deletes across checkout aliases without blocking other repositories or reads", async () => {
    const root = await repository();
    const other = await repository();
    const linked = path.join(root, "linked");
    const alias = path.join(tempDirs.make("openclaw-git-alias-"), "repo");
    await requireGit(root, ["worktree", "add", "--detach", linked, "HEAD"]);
    await requireGit(root, ["branch", "retired", "HEAD"]);
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const held = holdSnapshotDeletion();
    const first = runGit(root, ["update-ref", "-d", snapshotRef]);
    const pending: Promise<unknown>[] = [first];
    try {
      await held.started.promise;
      pending.push(requireGit(linked, ["branch", "-D", "retired"]));
      pending.push(
        requireGit(alias, ["update-ref", "--stdin"], { input: `delete ${queuedRef}\n` }),
      );
      await requireGit(other, ["update-ref", "-d", queuedRef]);
      await expect(requireGit(linked, ["rev-parse", "HEAD"])).resolves.toMatch(/^[a-f0-9]+$/);
      expect(held.mutations.filter((call) => call.cwd !== other)).toEqual([
        { cwd: root, args: ["update-ref", "-d", snapshotRef] },
      ]);
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
    }
    await expect(first).resolves.toMatchObject({ code: 0, timeoutMs: 120_000 });
    await Promise.all(pending);
    expect(await requireGit(root, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
    expect(await requireGit(other, ["show-ref", "--verify", snapshotRef])).toContain(snapshotRef);
  });

  it("rejects an interrupted explicit-base lookup even with exit code zero", async () => {
    const root = await repository();
    vi.spyOn(processExec, "runCommandWithTimeout").mockResolvedValueOnce({
      stdout: "refs/heads/-fixture\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "signal",
    });
    await expect(resolveWorktreeBase(root, "-fixture")).rejects.toThrow("terminated");
  });

  it.each(["fetch", "symbolic-ref"])(
    "does not select a remote base after an interrupted %s result",
    async (interrupted) => {
      const root = await repository();
      const localHead = await requireGit(root, ["rev-parse", "HEAD"]);
      const run = processExec.runCommandWithTimeout;
      vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) => {
        const command = argv[argv.indexOf("-C") + 2];
        if (command !== "fetch" && command !== "symbolic-ref") {
          return run(argv, options);
        }
        return Promise.resolve({
          stdout: command === "symbolic-ref" ? "origin/main\n" : "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: command === interrupted ? "signal" : "exit",
        });
      });
      await expect(resolveWorktreeBase(root)).resolves.toEqual({
        commit: localHead,
        gitOperand: "HEAD",
        recordRef: "HEAD",
        remote: false,
      });
    },
  );

  it("serializes configured fetch pruning during managed-worktree base resolution", async () => {
    const root = await repository();
    const origin = await repository();
    const staleRef = "refs/remotes/origin/retired";
    await requireGit(origin, ["branch", "retired", "HEAD"]);
    await requireGit(root, ["remote", "add", "origin", origin]);
    await requireGit(root, ["fetch", "origin"]);
    await requireGit(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await requireGit(root, ["config", "fetch.prune", "true"]);
    await requireGit(root, ["pack-refs", "--all"]);
    expect(await fs.readFile(path.join(root, ".git", "packed-refs"), "utf8")).toContain(staleRef);
    await requireGit(origin, ["branch", "-D", "retired"]);
    const originHead = await requireGit(origin, ["rev-parse", "HEAD"]);

    const controller = new AbortController();
    const held = holdSnapshotDeletion(undefined, controller.signal);
    const pending: Promise<unknown>[] = [runGit(root, ["update-ref", "-d", snapshotRef])];
    let resolved: ReturnType<typeof resolveWorktreeBase> | undefined;
    try {
      await held.started.promise;
      resolved = resolveWorktreeBase(root, undefined, controller.signal);
      pending.push(resolved);
      await expect(
        Promise.race([
          held.discovered.promise,
          resolved.then(() => {
            throw new Error("fetch completed before its queued discovery barrier");
          }),
        ]),
      ).resolves.toMatchObject({ code: 0, termination: "exit" });
      await expect(requireGit(root, ["show-ref", "--verify", staleRef])).resolves.toContain(
        staleRef,
      );
      expect(held.mutations).toEqual([{ cwd: root, args: ["update-ref", "-d", snapshotRef] }]);
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
    }
    await Promise.all(pending);
    await expect(resolved).resolves.toEqual({
      commit: originHead,
      gitOperand: "origin/main",
      recordRef: "origin/main",
      remote: true,
    });
    await expect(
      runGit(root, ["show-ref", "--verify", "--quiet", staleRef]),
    ).resolves.toMatchObject({
      code: 1,
    });
  });

  it("releases a rejected mutation and leaves a cancelled waiting branch deletion unexecuted", async () => {
    const root = await repository();
    await requireGit(root, ["branch", "kept", "HEAD"]);
    const failure = new Error("Git executor unavailable");
    const controller = new AbortController();
    const held = holdSnapshotDeletion(failure, controller.signal);
    const rejected = expect(requireGit(root, ["update-ref", "-d", snapshotRef])).rejects.toBe(
      failure,
    );
    const pending: Promise<unknown>[] = [rejected];
    let cancelled: Promise<Awaited<ReturnType<typeof runGit>>> | undefined;
    try {
      await held.started.promise;
      cancelled = runGit(root, ["branch", "-D", "kept"], { signal: controller.signal });
      pending.push(cancelled, requireGit(root, ["update-ref", "-d", queuedRef]));
      // Abort only after this candidate's real discovery settles; a separate read
      // can finish first and accidentally cancel discovery instead of the writer.
      await expect(
        Promise.race([
          held.discovered.promise,
          cancelled.then(() => {
            throw new Error("branch mutation completed before its queued discovery barrier");
          }),
        ]),
      ).resolves.toMatchObject({ code: 0, termination: "exit" });
      expect(held.mutations).toEqual([{ cwd: root, args: ["update-ref", "-d", snapshotRef] }]);
      controller.abort();
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
    }
    await Promise.all(pending);
    await expect(cancelled).resolves.toMatchObject({
      code: null,
      termination: "signal",
      killed: false,
    });
    expect(await requireGit(root, ["show-ref", "--verify", "refs/heads/kept"])).toContain(
      "refs/heads/kept",
    );
    expect((await runGit(root, ["show-ref", "--verify", "--quiet", queuedRef])).code).toBe(1);
  });

  it("keeps discovery and queued mutation in the captured Git environment", async () => {
    vi.stubEnv("GIT_COMMON_DIR", undefined);
    const root = await repository();
    const other = await repository();
    const held = holdSnapshotDeletion();
    const first = runGit(root, ["update-ref", "-d", snapshotRef]);
    const pending: Promise<unknown>[] = [first];
    try {
      await held.started.promise;
      pending.push(requireGit(root, ["update-ref", "-d", queuedRef]));
      // A newly introduced authority variable must not redirect a queued command
      // after its repository identity and inherited environment were captured.
      vi.stubEnv("GIT_COMMON_DIR", path.join(other, ".git"));
    } finally {
      held.release.resolve();
      await Promise.allSettled(pending);
      vi.stubEnv("GIT_COMMON_DIR", undefined);
    }
    await Promise.all(pending);
    expect((await runGit(root, ["show-ref", "--verify", "--quiet", queuedRef])).code).toBe(1);
    expect(await requireGit(other, ["show-ref", "--verify", queuedRef])).toContain(queuedRef);
  });
});

describe("Git execution environment", () => {
  it("preserves literal commit revisions only for Windows worktree Git", () => {
    expect(
      gitEnvironment(
        {
          MSYS: "winsymlinks:nativestrict",
          CYGWIN: "disable_pcon",
        },
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "win32",
      ),
    ).toMatchObject({
      MSYS: "winsymlinks:nativestrict noglob",
      CYGWIN: "disable_pcon noglob",
    });
    expect(gitEnvironment({ MSYS: "winsymlinks:nativestrict" }, ["status"], "win32").MSYS).toBe(
      "winsymlinks:nativestrict",
    );
  });

  it.each([
    ["noglob winsymlinks:native", "noglob winsymlinks:native noglob"],
    ["noglob glob:ignorecase", "noglob glob:ignorecase noglob"],
    ["winsymlinks:native noglob", "winsymlinks:native noglob"],
  ])("keeps noglob final for %s", (value, expected) => {
    expect(gitEnvironment({ MSYS: value }, ["rev-parse", "HEAD^{commit}"], "win32").MSYS).toBe(
      expected,
    );
  });

  it("merges inherited Windows runtime options before preserving revisions", () => {
    expect(
      gitEnvironment(
        { GIT_INDEX_FILE: "snapshot.index", msys: "winsymlinks:native", CYGWIN: undefined },
        ["rev-parse", "HEAD^{commit}"],
        "win32",
        { MSYS: "winsymlinks:nativestrict", CYGWIN: "disable_pcon" },
      ),
    ).toMatchObject({
      GIT_INDEX_FILE: "snapshot.index",
      MSYS: "winsymlinks:native noglob",
      CYGWIN: "noglob",
    });
    expect(
      gitEnvironment({ MSYS: "winsymlinks:native" }, ["rev-parse", "HEAD^{commit}"], "linux").MSYS,
    ).toBe("winsymlinks:native");
  });
});

describe("Git checkout discovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports a real Git failure with execution metadata through the worktree wrapper", async () => {
    const root = tempDirs.make("openclaw-git-error-");
    const result = await runGit(path.join(root, "missing"), ["status"]);

    expectTypeOf(result).toMatchTypeOf<SpawnResult>();
    expect(result.timeoutMs).toBe(120_000);
    expect(result.code).toBe(128);
    expect(result).toMatchObject({ termination: "exit", signal: null });
    const message = commandError("git status", result).message;
    expect(message).toContain("git status failed (exit code 128)");
    expect(message).toContain("fatal:");
    expect(message).not.toMatch(/timeout|timed out/i);
  });

  it("returns the nearest checkout root for nested paths", async () => {
    const root = tempDirs.make("openclaw-git-root-");
    const nested = path.join(root, "packages", "nested");
    await fs.mkdir(path.join(root, ".git"));
    await fs.mkdir(nested, { recursive: true });

    expect(findGitCheckoutRoot(nested)).toBe(root);
    expect(insideGitCheckout(nested)).toBe(true);
  });

  it("returns null outside a checkout", async () => {
    const root = tempDirs.make("openclaw-no-git-root-");

    expect(findGitCheckoutRoot(root)).toBeNull();
    expect(insideGitCheckout(root)).toBe(false);
  });

  it("distinguishes contained metadata from linked checkout pointers", async () => {
    const root = tempDirs.make("openclaw-git-metadata-");
    await fs.mkdir(path.join(root, ".git"));
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(true);

    await fs.rm(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git"), "gitdir: /outside/worktrees/card\n", "utf8");
    await expect(hasSelfContainedGitMetadata(root)).resolves.toBe(false);
  });

  it("parses existing linked worktree paths and lock reasons", async () => {
    const root = tempDirs.make("openclaw-git-worktree-list-");
    const repo = path.join(root, "repo");
    const linked = path.join(root, "linked");
    expect((await runGit(root, ["init", "-b", "main", repo])).code).toBe(0);
    expect((await runGit(repo, ["config", "user.name", "OpenClaw Test"])).code).toBe(0);
    expect(
      (await runGit(repo, ["config", "user.email", "openclaw-test@example.invalid"])).code,
    ).toBe(0);
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    expect((await runGit(repo, ["add", "README.md"])).code).toBe(0);
    expect((await runGit(repo, ["commit", "-m", "initial"])).code).toBe(0);
    expect((await runGit(repo, ["worktree", "add", "-b", "linked", linked, "HEAD"])).code).toBe(0);
    expect(
      (await runGit(repo, ["worktree", "lock", "--reason", "held by test", linked])).code,
    ).toBe(0);

    // These fixtures exist; compare identity without imposing Git's separator spelling.
    const worktrees = await listGitWorktrees(repo);
    for (const entry of worktrees) {
      entry.path = await fs.realpath(entry.path);
    }
    expect(worktrees).toContainEqual({
      path: await fs.realpath(linked),
      lockedReason: "held by test",
    });
  });
});
