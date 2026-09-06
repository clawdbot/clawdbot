// QA Lab product proof for the session-owned managed-worktree lifecycle.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import type { SessionsDeleteResult } from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
} from "../../../../src/agents/worktrees/types.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);

type SessionWorktree = { id: string; branch: string; repoRoot: string };
type SessionCreateResult = {
  key: string;
  entry: { spawnedCwd?: string; worktree?: SessionWorktree };
  worktree: { id: string; branch: string; path: string };
};
type SessionListResult = {
  sessions: Array<{
    key: string;
    spawnedCwd?: string;
    worktree?: SessionWorktree;
  }>;
};
type WorktreeListResult = { worktrees: ManagedWorktreeRecord[] };
type GatewayRunResult = { runId?: unknown; status?: unknown };

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

async function initializeRepository(root: string): Promise<{ baseCommit: string; repo: string }> {
  const repo = path.join(root, "source");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initialize session worktree fixture");
  return {
    baseCommit: await git(repo, "rev-parse", "HEAD"),
    repo: await fs.realpath(repo),
  };
}

async function createSessionWorktree(params: {
  name: string;
  repo: string;
}): Promise<SessionCreateResult> {
  if (!harness) {
    throw new Error("QA gateway harness is not running");
  }
  return (await harness.gateway.call(
    "sessions.create",
    {
      agentId: "qa",
      worktree: true,
      worktreeName: params.name,
      worktreeBaseRef: "main",
      cwd: params.repo,
    },
    { timeoutMs: 30_000 },
  )) as SessionCreateResult;
}

async function listWorktrees(): Promise<WorktreeListResult> {
  if (!harness) {
    throw new Error("QA gateway harness is not running");
  }
  return (await harness.gateway.call("worktrees.list", {})) as WorktreeListResult;
}

describe("managed worktrees session-owner product proof", () => {
  it(
    "creates, protects, snapshots, restores, and reports preserved session worktrees",
    { timeout: 240_000 },
    async () => {
      const canonicalTmp = await fs.realpath(os.tmpdir());
      const fixtureRoot = tempDirs.make("openclaw-managed-worktree-session-", canonicalTmp);
      const { baseCommit, repo } = await initializeRepository(fixtureRoot);
      gatewayOwner = createQaLiveLaneGateway();
      harness = await gatewayOwner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna",
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
      });
      const stateDir = path.join(await fs.realpath(harness.gateway.tempRoot), "state");

      const clean = await createSessionWorktree({ name: "qa-session-clean", repo });
      expect(clean.worktree).toMatchObject({
        id: expect.any(String),
        branch: "openclaw/qa-session-clean",
        path: expect.any(String),
      });
      expect(clean.entry.worktree).toMatchObject({
        id: clean.worktree.id,
        branch: clean.worktree.branch,
        repoRoot: repo,
      });
      expect(clean.entry.spawnedCwd).toBe(clean.worktree.path);

      const createdList = await listWorktrees();
      const cleanRecord = createdList.worktrees.find((record) => record.id === clean.worktree.id);
      expect(cleanRecord).toMatchObject({
        name: "qa-session-clean",
        repoRoot: repo,
        branch: clean.worktree.branch,
        ownerKind: "session",
        ownerId: clean.key,
      });
      expect(await fs.realpath(clean.worktree.path)).toBe(
        path.join(stateDir, "worktrees", cleanRecord?.repoFingerprint ?? "", "qa-session-clean"),
      );
      expect(await git(repo, "rev-parse", `refs/heads/${clean.worktree.branch}`)).toBe(baseCommit);

      const sessions = (await harness.gateway.call("sessions.list", {
        agentId: "qa",
      })) as SessionListResult;
      expect(sessions.sessions).toContainEqual(
        expect.objectContaining({
          key: clean.key,
          spawnedCwd: clean.worktree.path,
          worktree: expect.objectContaining({
            id: clean.worktree.id,
            branch: clean.worktree.branch,
            repoRoot: repo,
          }),
        }),
      );

      const started = (await harness.gateway.call(
        "chat.send",
        {
          sessionKey: clean.key,
          message: "Session worktree QA. Reply exactly `SESSION_WORKTREE_OK`.",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayRunResult;
      expect(started).toMatchObject({ runId: expect.any(String), status: "started" });
      const terminal = (await harness.gateway.call(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayRunResult;
      expect(terminal.status).toBe("ok");

      const gc = (await harness.gateway.call("worktrees.gc", {})) as ManagedWorktreeGcResult;
      expect(gc).toEqual({
        removed: expect.not.arrayContaining([clean.worktree.id]),
        orphansDeleted: expect.any(Number),
        snapshotsPruned: expect.any(Number),
      });
      expect((await listWorktrees()).worktrees).toContainEqual(
        expect.objectContaining({ id: clean.worktree.id, ownerId: clean.key }),
      );

      const cleanDeleted = (await harness.gateway.call("sessions.delete", {
        key: clean.key,
      })) as SessionsDeleteResult;
      expect(cleanDeleted.deleted).toBe(true);
      expect(cleanDeleted).not.toHaveProperty("worktreePreserved");
      await expect(fs.access(clean.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
      const cleanSnapshotRef = `refs/openclaw/snapshots/${clean.worktree.id}`;
      await expect(git(repo, "show-ref", "--verify", cleanSnapshotRef)).resolves.toContain(
        cleanSnapshotRef,
      );
      expect((await listWorktrees()).worktrees).toContainEqual(
        expect.objectContaining({
          id: clean.worktree.id,
          snapshotRef: cleanSnapshotRef,
          removedAt: expect.any(Number),
        }),
      );

      const dirty = await createSessionWorktree({ name: "qa-session-dirty", repo });
      const dirtyFile = path.join(dirty.worktree.path, "untracked-note.txt");
      await fs.writeFile(dirtyFile, "restore this note\n");
      const dirtyDeleted = (await harness.gateway.call("sessions.delete", {
        key: dirty.key,
      })) as SessionsDeleteResult;
      expect(dirtyDeleted.deleted).toBe(true);
      expect(dirtyDeleted).not.toHaveProperty("worktreePreserved");
      await expect(fs.access(dirty.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
      const dirtySnapshotRef = `refs/openclaw/snapshots/${dirty.worktree.id}`;
      const dirtySnapshotCommit = await git(repo, "rev-parse", dirtySnapshotRef);

      const restored = (await harness.gateway.call("worktrees.restore", {
        id: dirty.worktree.id,
      })) as ManagedWorktreeRecord;
      expect(restored).toMatchObject({
        id: dirty.worktree.id,
        branch: dirty.worktree.branch,
        path: dirty.worktree.path,
      });
      await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("restore this note\n");
      expect((await git(restored.path, "status", "--porcelain")).split("\n")).toContain(
        "?? untracked-note.txt",
      );
      expect((await git(repo, "log", "--format=%H", restored.branch)).split("\n")).not.toContain(
        dirtySnapshotCommit,
      );

      const locked = await createSessionWorktree({ name: "qa-session-locked", repo });
      await git(repo, "worktree", "lock", locked.worktree.path);
      const lockedDeleted = (await harness.gateway.call("sessions.delete", {
        key: locked.key,
      })) as SessionsDeleteResult;
      expect(lockedDeleted).toEqual(
        expect.objectContaining({
          deleted: true,
          worktreePreserved: {
            id: locked.worktree.id,
            branch: locked.worktree.branch,
            path: locked.worktree.path,
            reason: "foreign-lock",
          },
        }),
      );
      await expect(fs.access(locked.worktree.path)).resolves.toBeUndefined();
    },
  );
});
