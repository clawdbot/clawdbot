import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as processExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import {
  commandError,
  findGitCheckoutRoot,
  hasSelfContainedGitMetadata,
  insideGitCheckout,
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
      await expect(held.discovered.promise).resolves.toMatchObject({
        code: 0,
        termination: "exit",
      });
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
});
