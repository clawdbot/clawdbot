import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout,
}));

const COMMIT = "a".repeat(40);
const ADVERTISED_TIP = "b".repeat(40);
const ORIGIN = "https://example.invalid/openclaw.git";
const MANIFEST_REF = `sha256:${"c".repeat(64)}`;
const REMOTE_WORKSPACE = "/node/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkspaceExec = Parameters<typeof createNodeWorkerWorkspaceFallback>[0];

function spawnResult(stdout = "", code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, killed: false, termination: "exit" };
}

function cleanWorkspace(): string {
  const root = tempDirs.make("node-worker-origin-workspace-");
  runCommandWithTimeout.mockReset();
  runCommandWithTimeout.mockImplementation(async (argv: string[]) => {
    const args = argv.slice(argv.indexOf("-C") + 2);
    switch (args.join(" ")) {
      case "rev-parse --show-toplevel":
        return spawnResult(root);
      case "status --porcelain=v1 --untracked-files=all":
        return spawnResult();
      case "rev-parse HEAD":
        return spawnResult(COMMIT);
      case "remote get-url origin":
        return spawnResult(ORIGIN);
      case `ls-remote --heads --tags -- ${ORIGIN}`:
        return spawnResult(`${ADVERTISED_TIP}\trefs/heads/main\n`);
      default:
        throw new Error(`unexpected local Git command: ${args.join(" ")}`);
    }
  });
  return root;
}

describe("node worker workspace origin fallback", () => {
  it("clones a clean commit without requiring it to be an advertised ref tip", async () => {
    const localPath = cleanWorkspace();
    const exec = vi.fn<WorkspaceExec>(async ({ argv }) => ({
      ...spawnResult(argv[0] === "node" ? MANIFEST_REF : ""),
      workspaceDir: REMOTE_WORKSPACE,
    }));

    await expect(
      createNodeWorkerWorkspaceFallback(exec).trySyncWorkspace(
        { localPath, sessionId: "session-1", generation: 1 },
        MANIFEST_REF,
      ),
    ).resolves.toEqual({
      kind: "synced",
      result: { mode: "git", remoteWorkspaceDir: REMOTE_WORKSPACE, manifestRef: MANIFEST_REF },
    });

    expect(exec.mock.calls.map(([command]) => command.argv)).toEqual([
      expect.arrayContaining(["clone", "--filter=blob:none", ORIGIN]),
      expect.arrayContaining(["checkout", COMMIT]),
      expect.arrayContaining(["node", REMOTE_WORKSPACE, COMMIT]),
    ]);
    expect(runCommandWithTimeout).not.toHaveBeenCalledWith(
      expect.arrayContaining(["ls-remote"]),
      expect.anything(),
    );
  });

  it.each([
    { operation: "clone", reason: "clone-failed", commandCount: 1 },
    { operation: "checkout", reason: "checkout-failed", commandCount: 2 },
  ] as const)("preserves the $reason fallback", async ({ operation, reason, commandCount }) => {
    const localPath = cleanWorkspace();
    const exec = vi.fn<WorkspaceExec>(async ({ argv }) => ({
      ...spawnResult("", argv.includes(operation) ? 1 : 0),
      workspaceDir: REMOTE_WORKSPACE,
    }));

    await expect(
      createNodeWorkerWorkspaceFallback(exec).trySyncWorkspace(
        { localPath, sessionId: "session-1", generation: 1 },
        MANIFEST_REF,
      ),
    ).resolves.toEqual({ kind: "fallback", reason });
    expect(exec).toHaveBeenCalledTimes(commandCount);
  });
});
