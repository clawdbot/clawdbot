// Workboard tests cover the sqlite batch card read path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

function fixtureCard(index: number): WorkboardCard {
  const id = `card-${index}`;
  return {
    id,
    title: `Card ${index}`,
    status: "todo",
    priority: "normal",
    labels: [`label-${index}`, "shared"],
    position: index,
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    events: [{ id: `${id}-event`, kind: "created", at: 1000 + index }],
    metadata: {
      attempts: [{ id: `${id}-attempt`, status: "succeeded", startedAt: 1000 + index }],
      comments: [{ id: `${id}-comment`, body: `note ${index}`, createdAt: 1000 + index }],
      links: [
        { id: `${id}-link`, type: "reference", url: "https://example.test", createdAt: 1000 },
      ],
      proof: [{ id: `${id}-proof`, status: "passed", label: "unit", createdAt: 1000 }],
      artifacts: [{ id: `${id}-artifact`, label: "log", createdAt: 1000 }],
      attachments: [
        {
          id: `${id}-attachment`,
          cardId: id,
          fileName: "note.txt",
          byteSize: 4,
          createdAt: 1000,
        },
      ],
      workerLogs: [
        { id: `${id}-log`, level: "info", message: `log ${index}`, createdAt: 1000 + index },
      ],
      diagnostics: [
        {
          kind: "stranded_ready",
          severity: "warning",
          title: "Stranded",
          detail: "detail",
          firstSeenAt: 1000,
          lastSeenAt: 1000,
          count: 1,
          actions: [],
        },
      ],
      notifications: [
        { id: `${id}-notify`, kind: "failed", message: "boom", createdAt: 1000 + index },
      ],
      workerProtocol: { state: "idle", updatedAt: 1000 + index, detail: "waiting" },
    },
  };
}

function withStores<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-batch-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  return run(dbPath).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe("workboard sqlite batch card read", () => {
  it("returns exactly what the per-card read returns", async () => {
    await withStores(async (dbPath) => {
      const stores = createWorkboardSqliteStores({ dbPath });
      try {
        for (let index = 0; index < 5; index++) {
          await stores.cards.register(`card-${index}`, { version: 1, card: fixtureCard(index) });
        }
        const batch = await stores.cards.entries();
        // The batch path must not drop, reorder, or reshape a single child row.
        for (const entry of batch) {
          await expect(stores.cards.lookup(entry.key)).resolves.toEqual(entry.value);
        }
        expect(batch.map((entry) => entry.key)).toEqual([
          "card-0",
          "card-1",
          "card-2",
          "card-3",
          "card-4",
        ]);
      } finally {
        stores.close();
      }
    });
  });

  it("issues the same number of statements no matter how many cards exist", async () => {
    await withStores(async (dbPath) => {
      const stores = createWorkboardSqliteStores({ dbPath });
      try {
        const prepared = async (cardCount: number): Promise<number> => {
          for (let index = 0; index < cardCount; index++) {
            await stores.cards.register(`card-${index}`, { version: 1, card: fixtureCard(index) });
          }
          const before = statementCount;
          await stores.cards.entries();
          return statementCount - before;
        };
        let statementCount = 0;
        // The store owns its connection, so the prototype is the only seam to count from.
        const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
        if (!descriptor?.value) {
          throw new Error("DatabaseSync.prototype.prepare is not an own property");
        }
        const original = descriptor.value as (this: DatabaseSync, sql: string) => unknown;
        Object.defineProperty(DatabaseSync.prototype, "prepare", {
          ...descriptor,
          value: function countingPrepare(this: DatabaseSync, sql: string) {
            statementCount++;
            return original.call(this, sql);
          },
        });
        try {
          const few = await prepared(3);
          const many = await prepared(30);
          // A per-card read would make this grow by a factor of ten.
          expect(many).toBe(few);
        } finally {
          Object.defineProperty(DatabaseSync.prototype, "prepare", descriptor);
        }
      } finally {
        stores.close();
      }
    });
  });
});
