import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardCardWorktree } from "./dispatcher-workspace.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("cleanupWorkboardCardWorktree", () => {
  it("releases the run lock before requesting lossless cleanup", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Artifact-producing worker",
      status: "done",
      runId: "run-artifact",
      workspace: {
        kind: "worktree",
        path: "/tmp/worktree",
        branch: "openclaw/wb-card",
        sourcePath: "/repo",
        sourceBranch: "main",
      },
      workspaceAccess: { unrestricted: true },
    });
    const worktrees = {
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(false),
    };

    await cleanupWorkboardCardWorktree({ store, worktrees, card });

    expect(worktrees.release).toHaveBeenCalledWith({ path: "/tmp/worktree" });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/tmp/worktree",
      ownerKind: "workboard",
      ownerId: card.id,
    });
    expect(worktrees.release.mock.invocationCallOrder[0]!).toBeLessThan(
      worktrees.removeIfLossless.mock.invocationCallOrder[0]!,
    );
  });

  it("ignores runs without a persisted managed-worktree workspace", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "No worktree", status: "done", runId: "run-local" });
    const worktrees = {
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    await cleanupWorkboardCardWorktree({ store, worktrees, card });

    expect(worktrees.release).not.toHaveBeenCalled();
    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
  });
});
