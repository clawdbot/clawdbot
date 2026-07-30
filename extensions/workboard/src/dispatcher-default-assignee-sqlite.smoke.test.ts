// Real-setup smoke proof for #116358 (requested by ClawSweeper's "non-mock after-fix
// dispatch evidence" ask): dispatches through a real on-disk SQLite-backed
// WorkboardStore, then re-opens a fresh store instance from that same file to prove the
// board default assignee, agentId, and claim were durably persisted - not just visible
// to the in-process store instance that ran the dispatch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function openStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
    dataVersion: stores.dataVersion,
  });
  return { store, close: stores.close };
}

describe("workboard defaultAssignee - real sqlite dispatch", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-default-assignee-"));
    dbPath = path.join(dir, "workboard.sqlite");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the board default assignee onto a real sqlite-backed dispatch, durable across a store re-open", async () => {
    const writer = openStore(dbPath);
    let cardId: string;
    try {
      await writer.store.upsertBoard({ id: "ops", orchestration: { defaultAssignee: "ops-bot" } });
      const card = await writer.store.create({
        title: "Real sqlite ownerless card",
        status: "ready",
        boardId: "ops",
        workspaceAccess: { unrestricted: true },
      });
      cardId = card.id;

      const run = vi.fn().mockResolvedValue({ runId: "run-real-sqlite" });
      const result = await dispatchAndStartWorkboardCards({
        store: writer.store,
        subagent: { run },
        options: { now: Date.parse("2026-07-30T00:00:00Z"), maxStarts: 1 },
      });

      process.stdout.write(
        `\n===WORKBOARD SQLITE SMOKE===\n` +
          `dbPath: ${dbPath}\n` +
          `dispatch result: started=${result.started.length} failures=${result.startFailures.length}\n` +
          `run() called with sessionKey: ${String((run.mock.calls[0]?.[0] as { sessionKey?: string })?.sessionKey)}\n`,
      );

      expect(result.started).toEqual([
        expect.objectContaining({ cardId, runId: "run-real-sqlite" }),
      ]);
    } finally {
      writer.close();
    }

    // Fresh process-level store instance, same file: proves the write actually landed
    // on disk rather than only existing in the writer's in-memory cache.
    const reader = openStore(dbPath);
    try {
      const persisted = await reader.store.get(cardId);
      process.stdout.write(
        `re-opened card: agentId=${persisted?.agentId} status=${persisted?.status} ` +
          `claimOwner=${persisted?.metadata?.claim?.ownerId}\n` +
          `===END===\n`,
      );
      expect(persisted).toMatchObject({
        agentId: "ops-bot",
        status: "running",
        metadata: { claim: { ownerId: "ops-bot" } },
      });
    } finally {
      reader.close();
    }
  });
});
