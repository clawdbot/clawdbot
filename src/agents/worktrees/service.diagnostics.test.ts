import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandExec from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const realRunCommand = commandExec.runCommandWithTimeout;
const emptyFailure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 73,
  signal: null,
  killed: false,
  termination: "exit",
};

async function failureMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected worktree operation to fail");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

const terminationCases: Array<{
  name: string;
  result: Partial<SpawnResult>;
  expected: RegExp[];
}> = [
  {
    name: "exit without output",
    result: { code: 23 },
    expected: [/(?:exit|code|status)[^\n]*23/i],
  },
  {
    name: "exit with output",
    result: { code: 23, stderr: "fatal: dependency unavailable" },
    expected: [/fatal: dependency unavailable/, /(?:exit|code|status)[^\n]*23/i],
  },
  {
    name: "timeout with output",
    result: {
      code: 124,
      termination: "timeout",
      signal: "SIGTERM",
      killed: true,
      stderr: "waiting for dependency",
    },
    expected: [/waiting for dependency/, /timed?\s*out|timeout/i, /SIGTERM/],
  },
  {
    name: "timeout without output",
    result: {
      code: 124,
      termination: "timeout",
      signal: "SIGKILL",
      killed: true,
    },
    expected: [/timed?\s*out|timeout/i, /SIGKILL/],
  },
  {
    name: "signal without output",
    result: { code: null, termination: "signal", signal: "SIGTERM" },
    expected: [/SIGTERM/],
  },
];

describe("ManagedWorktreeService failure diagnostics", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-errors-"));
    repo = await initializeRepository(root);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeFailingSetup(): Promise<string> {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, "#!/bin/sh\nprintf 'fatal: setup failed\\n' >&2\nexit 9\n", {
      mode: 0o755,
    });
    return script;
  }

  it.each(terminationCases)("reports setup $name and removes its allocation", async (entry) => {
    const script = await writeFailingSetup();
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === script) {
        return { ...emptyFailure, ...entry.result };
      }
      return await realRunCommand(argv, options);
    });

    const message = await failureMessage(
      service.create({ repoRoot: repo, name: "terminated-setup", baseRef: "HEAD" }),
    );

    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("terminated-setup");
    expect(await git(repo, "branch", "--list", "openclaw/terminated-setup")).toBe("");
    expect(service.listRegistryRecords()).toEqual([]);
    expect(message).toContain("worktree setup failed");
    for (const pattern of entry.expected) {
      expect.soft(message).toMatch(pattern);
    }
    expect(message.length).toBeLessThanOrEqual(2_300);
  });

  it.each([
    { phase: "create", failedOperation: "remove" },
    { phase: "create", failedOperation: "branch" },
    { phase: "create", failedOperation: "both" },
    { phase: "restore", failedOperation: "remove" },
    { phase: "restore", failedOperation: "branch" },
    { phase: "restore", failedOperation: "both" },
  ] as const)(
    "reports the failed $failedOperation operation during $phase cleanup",
    async ({ phase, failedOperation }) => {
      const removeFails = failedOperation !== "branch";
      const branchFails = failedOperation !== "remove";
      const name = "cleanup-failure";
      const branch = `openclaw/${name}`;
      let record;
      if (phase === "restore") {
        record = await service.create({ repoRoot: repo, name, baseRef: "HEAD" });
        await service.remove({ id: record.id, reason: "test" });
      } else {
        await writeFailingSetup();
      }
      const registryBefore = service.listRegistryRecords();
      const fatal = "fatal: branch deletion denied";
      let cleanupPath: string | undefined;
      vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const args = argv[0] === "git" ? argv.slice(3) : [];
        if (phase === "restore" && args[0] === "reset") {
          return { ...emptyFailure, code: 45, stderr: "fatal: restore index failed" };
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          cleanupPath = args.at(-1);
          const removed = await realRunCommand(argv, options);
          expect(removed.code).toBe(0);
          // A child can fail after applying its filesystem effects. Later branch
          // deletion output must not mask this removal failure.
          return removeFails ? emptyFailure : { ...removed, stdout: "worktree removal complete" };
        }
        if (args[0] === "branch" && args[1] === "-D" && branchFails) {
          return {
            ...emptyFailure,
            stderr: `${"Deleting branch\r".repeat(200)}\n${"x".repeat(8_000)}${fatal}`,
          };
        }
        return await realRunCommand(argv, options);
      });

      const message = await failureMessage(
        record
          ? service.restore({ id: record.id })
          : service.create({ repoRoot: repo, name, baseRef: "HEAD" }),
      );

      expect(cleanupPath).toBeDefined();
      await expect(fs.stat(cleanupPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(service.listRegistryRecords()).toEqual(registryBefore);
      expect(await git(repo, "branch", "--list", branch)).toBe(branchFails ? branch : "");
      if (record) {
        expect(await git(repo, "show-ref", "--verify", registryBefore[0]!.snapshotRef!)).not.toBe(
          "",
        );
      }
      expect(message).toContain(
        phase === "restore" ? "fatal: restore index failed" : "fatal: setup failed",
      );
      const label =
        phase === "restore" ? "restore cleanup failed:" : "failed to clean up worktree creation:";
      expect(message).toContain(label);
      const cleanupMessage = message.slice(message.indexOf(label) + label.length);
      expect.soft(cleanupMessage).toContain(removeFails ? "git worktree remove" : "git branch -D");
      expect.soft(/(?:exit|code|status)[^\n]*73/i.test(cleanupMessage)).toBe(true);
      expect.soft(cleanupMessage).not.toContain("worktree removal complete");
      expect.soft(cleanupMessage).not.toContain("Deleted branch");
      if (!removeFails) {
        expect.soft(cleanupMessage.includes(fatal)).toBe(true);
      } else {
        expect.soft(cleanupMessage).not.toContain(fatal);
      }
      expect.soft(cleanupMessage.length).toBeLessThanOrEqual(2_300);
    },
  );

  it.each([
    { name: "long evidence inside the existing window", oldEvidenceVisible: true },
    { name: "evidence outside the existing newline window", oldEvidenceVisible: false },
  ])("preserves retry authority for $name", async ({ oldEvidenceVisible }) => {
    await git(path.join(root, "remote.git"), "symbolic-ref", "HEAD", "refs/heads/main");
    await git(repo, "remote", "set-head", "origin", "-a");
    const name = "retry-evidence";
    const branch = `openclaw/${name}`;
    let allocatedPath: string | undefined;
    let firstAdd = true;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRunCommand(argv, options);
      const args = argv[0] === "git" ? argv.slice(3) : [];
      if (firstAdd && args[0] === "worktree" && args[1] === "add") {
        firstAdd = false;
        allocatedPath = args.at(-2);
        expect(result.code).toBe(0);
        const separator = oldEvidenceVisible ? "\r" : "\n";
        return {
          ...result,
          code: 1,
          stderr: `Preparing worktree (new branch '${branch}')${separator}${`progress ${"x".repeat(200)}${separator}`.repeat(20)}fatal: checkout failed`,
        };
      }
      return result;
    });

    if (oldEvidenceVisible) {
      const created = await service.create({ repoRoot: repo, name });
      expect(created.baseRef).toBe("HEAD");
      expect(await git(created.path, "branch", "--show-current")).toBe(branch);
      expect(service.listRegistryRecords()).toEqual([created]);
    } else {
      await expect(service.create({ repoRoot: repo, name })).rejects.toThrow("checkout failed");
      expect(service.listRegistryRecords()).toEqual([]);
    }
    expect(allocatedPath).toBeDefined();
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(allocatedPath);
    expect(await git(allocatedPath!, "branch", "--show-current")).toBe(branch);
  });
});
