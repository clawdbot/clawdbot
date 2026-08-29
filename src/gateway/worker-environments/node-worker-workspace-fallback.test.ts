import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout,
}));

const COMMIT = "a".repeat(40);
const ADVERTISED_TIP = "b".repeat(40);
const ORIGIN = "https://example.invalid/openclaw.git";
const SEED_KEY = "f768fa4834ce38c2cc9d0050df323298de898870b2cf372c95da0a7965dad806";
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
      case "config --get user.name":
        return spawnResult("Gateway Repository Author");
      case "config --get user.email":
        return spawnResult("gateway-author@example.invalid");
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
    const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => ({
      ...spawnResult(
        seed?.action === "apply" ? "absent\n" : argv[0] === "node" ? MANIFEST_REF : "",
      ),
      workspaceDir: REMOTE_WORKSPACE,
    }));

    await expect(
      createNodeWorkerWorkspaceFallback(exec).trySyncWorkspace(
        { localPath, sessionId: "session-1", generation: 1 },
        MANIFEST_REF,
      ),
    ).resolves.toEqual({
      kind: "synced",
      seeded: false,
      result: { mode: "git", remoteWorkspaceDir: REMOTE_WORKSPACE, manifestRef: MANIFEST_REF },
    });

    expect(exec.mock.calls.map(([command]) => command.argv)).toEqual([
      ["openclaw-internal-workspace-seed"],
      expect.arrayContaining(["clone", "--filter=blob:none", ORIGIN]),
      expect.arrayContaining(["checkout", COMMIT]),
      expect.arrayContaining(["node", REMOTE_WORKSPACE, COMMIT]),
      ["openclaw-internal-workspace-seed"],
    ]);
    expect(exec.mock.calls.at(-1)?.[0]).toEqual({
      argv: ["openclaw-internal-workspace-seed"],
      seed: { action: "store", key: SEED_KEY, maxAgeMs: 6 * 60 * 60 * 1000 },
      timeoutMs: 180_000,
      transportRetry: "never",
    });
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
    expect(exec).toHaveBeenCalledTimes(commandCount + 1);
    expect(exec.mock.calls.some(([command]) => command.seed?.action === "store")).toBe(false);
  });

  it.each(["none", "remote-mismatch", "fetch-failed", "manifest-mismatch", "apply-error"] as const)(
    "uses the seed when valid and recovers by cloning after %s",
    async (failure) => {
      const localPath = cleanWorkspace();
      let cloned = false;
      const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
        if (seed?.action === "apply" && failure === "apply-error") {
          throw new Error("seed copy failed");
        }
        if (argv.includes("clone")) {
          cloned = true;
        }
        let stdout = "";
        if (seed?.action === "apply") {
          stdout = "applied\n";
        } else if (argv.includes("get-url")) {
          stdout =
            failure === "remote-mismatch" ? "https://example.invalid/other.git" : `${ORIGIN}\n`;
        } else if (argv[0] === "node") {
          stdout =
            !cloned && failure === "manifest-mismatch" ? `sha256:${"d".repeat(64)}` : MANIFEST_REF;
        }
        return {
          ...spawnResult(stdout, argv.includes("fetch") && failure === "fetch-failed" ? 1 : 0),
          workspaceDir: REMOTE_WORKSPACE,
        };
      });

      await expect(
        createNodeWorkerWorkspaceFallback(exec).trySyncWorkspace(
          { localPath, sessionId: "session-1", generation: 1 },
          MANIFEST_REF,
        ),
      ).resolves.toEqual({
        kind: "synced",
        seeded: failure === "none",
        result: { mode: "git", remoteWorkspaceDir: REMOTE_WORKSPACE, manifestRef: MANIFEST_REF },
      });
      expect(exec.mock.calls[0]?.[0]).toEqual({
        argv: ["openclaw-internal-workspace-seed"],
        seed: { action: "apply", key: SEED_KEY },
        timeoutMs: 60_000,
        transportRetry: "never",
      });
      expect(cloned).toBe(failure !== "none");
      const commands = exec.mock.calls.map(([command]) => command);
      if (failure === "none") {
        expect(commands[1]?.argv).toEqual([
          "git",
          "-c",
          "credential.helper=",
          "-c",
          "core.askPass=",
          "remote",
          "get-url",
          "origin",
        ]);
        expect(commands[2]).toEqual({
          argv: [
            "git",
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=",
            "fetch",
            "--prune",
            "origin",
            "+refs/heads/*:refs/remotes/origin/*",
          ],
          timeoutMs: 60_000,
          transportRetry: "never",
        });
        expect(commands[3]).toEqual({
          argv: [
            "git",
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=",
            "checkout",
            "--detach",
            "--force",
            COMMIT,
          ],
          timeoutMs: 60_000,
          transportRetry: "never",
        });
      } else {
        expect(commands.find((command) => command.argv.includes("clone"))?.resetWorkspace).toBe(
          true,
        );
      }
      expect(commands.filter((command) => command.seed?.action === "store")).toEqual([
        {
          argv: ["openclaw-internal-workspace-seed"],
          seed: { action: "store", key: SEED_KEY, maxAgeMs: 6 * 60 * 60 * 1000 },
          timeoutMs: 180_000,
          transportRetry: "never",
        },
      ]);
    },
  );

  it.each(["apply", "store"] as const)(
    "disables seed operations after INVALID_REQUEST from %s",
    async (rejectedAction) => {
      const localPath = cleanWorkspace();
      const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
        if (seed?.action === rejectedAction) {
          throw new Error("node workspace command failed (INVALID_REQUEST): unknown field seed");
        }
        return {
          ...spawnResult(
            seed?.action === "apply" ? "absent\n" : argv[0] === "node" ? MANIFEST_REF : "",
          ),
          workspaceDir: REMOTE_WORKSPACE,
        };
      });
      const workspace = createNodeWorkerWorkspaceFallback(exec);
      const request = { localPath, sessionId: "session-1", generation: 1 };

      await expect(workspace.trySyncWorkspace(request, MANIFEST_REF)).resolves.toMatchObject({
        kind: "synced",
        seeded: false,
      });
      expect(exec.mock.calls.filter(([command]) => command.seed)).toHaveLength(
        rejectedAction === "apply" ? 1 : 2,
      );
      exec.mockClear();
      await expect(workspace.trySyncWorkspace(request, MANIFEST_REF)).resolves.toMatchObject({
        kind: "synced",
        seeded: false,
      });
      expect(exec.mock.calls.some(([command]) => command.seed)).toBe(false);
      expect(exec.mock.calls.some(([command]) => command.argv.includes("clone"))).toBe(true);
    },
  );

  it("awaits seed storage before releasing the synced workspace and tolerates its failure", async () => {
    const localPath = cleanWorkspace();
    const storing = createDeferredCore();
    const stored = createDeferredCore();
    const events: string[] = [];
    const exec = vi.fn<WorkspaceExec>(async ({ argv, seed }) => {
      if (seed?.action === "store") {
        events.push("storing");
        storing.resolve();
        await stored.promise;
        throw new Error("seed cache is full");
      }
      return {
        ...spawnResult(
          seed?.action === "apply" ? "absent\n" : argv[0] === "node" ? MANIFEST_REF : "",
        ),
        workspaceDir: REMOTE_WORKSPACE,
      };
    });
    const syncing = createNodeWorkerWorkspaceFallback(exec)
      .trySyncWorkspace({ localPath, sessionId: "session-1", generation: 1 }, MANIFEST_REF)
      .then((outcome) => {
        events.push("synced");
        return outcome;
      });
    await Promise.race([storing.promise, syncing]);
    expect(events).toEqual(["storing"]);
    stored.resolve();
    await expect(syncing).resolves.toMatchObject({ kind: "synced", seeded: false });
    expect(events).toEqual(["storing", "synced"]);
  });

  it.each([
    {
      label: "fully inherited identity",
      gitAuthor: undefined,
      expected: ["Gateway Repository Author", "gateway-author@example.invalid"],
    },
    {
      label: "configured name with inherited email",
      gitAuthor: { name: "Configured Author" },
      expected: ["Configured Author", "gateway-author@example.invalid"],
    },
    {
      label: "inherited name with configured email",
      gitAuthor: { email: "configured@example.invalid" },
      expected: ["Gateway Repository Author", "configured@example.invalid"],
    },
  ])("projects $label into a materialized Git workspace", async ({ gitAuthor, expected }) => {
    const localPath = cleanWorkspace();
    const exec = vi.fn<WorkspaceExec>(async () => ({
      ...spawnResult(),
      workspaceDir: REMOTE_WORKSPACE,
    }));
    const result = {
      mode: "git" as const,
      remoteWorkspaceDir: REMOTE_WORKSPACE,
      manifestRef: MANIFEST_REF,
    };

    await expect(
      createNodeWorkerWorkspaceFallback(exec).finalizeSync(
        { localPath, sessionId: "session-1", generation: 1, ...(gitAuthor ? { gitAuthor } : {}) },
        result,
      ),
    ).resolves.toEqual(result);
    expect(exec.mock.calls.map(([command]) => command.argv.slice(-2))).toEqual([
      ["user.name", expected[0]],
      ["user.email", expected[1]],
    ]);
  });

  it("fails closed when a node rejects its Gateway Git author", async () => {
    const localPath = cleanWorkspace();
    const exec = vi.fn<WorkspaceExec>(async () => ({
      ...spawnResult("", 1),
      stderr: "node Git config rejected the author",
      workspaceDir: REMOTE_WORKSPACE,
    }));

    await expect(
      createNodeWorkerWorkspaceFallback(exec).finalizeSync(
        { localPath, sessionId: "session-1", generation: 1 },
        { mode: "git", remoteWorkspaceDir: REMOTE_WORKSPACE, manifestRef: MANIFEST_REF },
      ),
    ).rejects.toThrow("Worker workspace sync failed: node Git config rejected the author");
  });

  it("does not apply Git author configuration to a plain workspace", async () => {
    const localPath = cleanWorkspace();
    const exec = vi.fn<WorkspaceExec>();
    const result = {
      mode: "plain" as const,
      remoteWorkspaceDir: REMOTE_WORKSPACE,
      manifestRef: MANIFEST_REF,
    };

    await expect(
      createNodeWorkerWorkspaceFallback(exec).finalizeSync(
        { localPath, sessionId: "session-1", generation: 1, gitAuthor: { name: "Configured" } },
        result,
      ),
    ).resolves.toEqual(result);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects malformed Git authors before inspecting a node workspace", async () => {
    const localPath = cleanWorkspace();

    await expect(
      createNodeWorkerWorkspaceFallback(vi.fn<WorkspaceExec>()).trySyncWorkspace(
        { localPath, sessionId: "session-1", generation: 1, gitAuthor: { name: "invalid\nname" } },
        MANIFEST_REF,
      ),
    ).rejects.toThrow("Worker workspace Git author metadata is invalid");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
