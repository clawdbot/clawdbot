import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

describe("Workboard dispatcher compensation", () => {
  it.each([
    {
      edit: "unrelated notes",
      hostWorkspace: undefined,
      expectedWorkspace: { kind: "worktree", path: "/repo", branch: "main" } as const,
    },
    {
      edit: "workspace",
      hostWorkspace: {
        kind: "worktree",
        path: "/host-workspace",
        branch: "host-branch",
        sourcePath: "/host-source",
        sourceBranch: "host-base",
      } as const,
      expectedWorkspace: {
        kind: "worktree",
        path: "/host-workspace",
        branch: "host-branch",
        sourcePath: "/host-source",
        sourceBranch: "host-base",
      } as const,
    },
  ])("compensates a materialized workspace after a concurrent $edit edit", async (testCase) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-dispatch-rollback-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const dispatchStores = createWorkboardSqliteStores({ dbPath });
    const hostStores = createWorkboardSqliteStores({ dbPath });
    const store = new WorkboardStore(dispatchStores.cards);
    const host = new WorkboardStore(hostStores.cards);
    try {
      const card = await store.create({
        title: "Isolated worker",
        status: "ready",
        workspace: { kind: "worktree", path: "/repo", branch: "main" },
        workspaceAccess: { unrestricted: true },
      });
      const worktrees = {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockResolvedValue({
          id: "managed-id",
          path: "/state/worktrees/fingerprint/wb-card",
          branch: `openclaw/wb-${card.id}`,
        }),
        release: vi.fn(),
        removeIfLossless: vi.fn().mockResolvedValue(true),
      };
      const run = vi.fn(async () => {
        await host.update(card.id, {
          notes: "Concurrent host edit",
          ...(testCase.hostWorkspace ? { workspace: testCase.hostWorkspace } : {}),
        });
        throw new Error("model unavailable");
      });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        worktrees,
        options: { now: 10, maxStarts: 1, materializeWorktree: true },
      });

      expect(result.startFailures).toEqual([
        expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
      ]);
      const persisted = await host.get(card.id);
      expect(persisted).toMatchObject({
        status: "blocked",
        notes: "Concurrent host edit",
      });
      expect(persisted?.metadata?.automation?.workspace).toEqual(testCase.expectedWorkspace);
    } finally {
      hostStores.close();
      dispatchStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
