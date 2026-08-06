// Workboard tests cover the sqlite batch card read path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

const sqliteStatements = vi.hoisted(() => ({ count: 0, sql: [] as string[] }));

vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        sqliteStatements.count++;
        sqliteStatements.sql.push(sql);
        return prepare(sql);
      });
      return db;
    },
  };
});

function fixtureCard(index: number, proofCount = 1): WorkboardCard {
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
        { id: `${id}-link`, type: "relates_to", url: "https://example.test", createdAt: 1000 },
      ],
      proof: Array.from({ length: proofCount }, (_, proofIndex) => ({
        id: `${id}-proof-${proofIndex}`,
        status: "passed" as const,
        label: `unit ${proofIndex}`,
        ...(proofIndex === 0 ? { note: `historical note ${index}` } : {}),
        createdAt: 1000 + proofIndex,
      })),
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
        let registeredCards = 0;
        const prepared = async (cardCount: number): Promise<number> => {
          for (let index = registeredCards; index < cardCount; index++) {
            await stores.cards.register(`card-${index}`, { version: 1, card: fixtureCard(index) });
          }
          registeredCards = cardCount;
          const before = sqliteStatements.count;
          await stores.cards.entries();
          return sqliteStatements.count - before;
        };
        const few = await prepared(3);
        const many = await prepared(30);

        expect(many).toBe(few);
      } finally {
        stores.close();
      }
    });
  });

  it("batch-reads bounded proof pages without loading complete proof history", async () => {
    await withStores(async (dbPath) => {
      const stores = createWorkboardSqliteStores({ dbPath });
      try {
        let registeredCards = 0;
        const measure = async (cardCount: number) => {
          for (let index = registeredCards; index < cardCount; index++) {
            await stores.cards.register(`card-${index}`, {
              version: 1,
              card: fixtureCard(index, 12),
            });
          }
          registeredCards = cardCount;
          const beforeCount = sqliteStatements.count;
          const beforeSql = sqliteStatements.sql.length;
          const pages = await stores.cards.listCardProofPages?.({ limit: 3 });
          if (!pages) {
            throw new Error("sqlite store does not expose bounded card proof pages");
          }
          return {
            pages,
            statementCount: sqliteStatements.count - beforeCount,
            sql: sqliteStatements.sql.slice(beforeSql),
          };
        };

        const few = await measure(3);
        const many = await measure(30);

        expect(many.statementCount).toBe(few.statementCount);
        expect(many.pages).toHaveLength(30);
        expect(many.pages[0]?.card.metadata?.proof).toBeUndefined();
        expect(many.pages[0]).toMatchObject({
          card: { id: "card-0" },
          proofPage: {
            proof: [{ id: "card-0-proof-9" }, { id: "card-0-proof-10" }, { id: "card-0-proof-11" }],
            total: 12,
            hasMore: true,
          },
          latestProofNote: "historical note 0",
        });
        const batchSql = many.sql.join("\n");
        expect(batchSql).toContain("CROSS JOIN workboard_card_proof AS proof");
        expect(batchSql).toContain("GROUP BY card_id");
        expect(batchSql).not.toContain("ROW_NUMBER()");
        expect(batchSql).not.toContain("COUNT(*) OVER");
      } finally {
        stores.close();
      }
    });
  });

  it("matches single-card proof pages below, at, and above the limit", async () => {
    await withStores(async (dbPath) => {
      const stores = createWorkboardSqliteStores({ dbPath });
      try {
        const proofCounts = [0, 2, 3, 5];
        for (const [index, proofCount] of proofCounts.entries()) {
          await stores.cards.register(`card-${index}`, {
            version: 1,
            card: fixtureCard(index, proofCount),
          });
        }

        const batch = await stores.cards.listCardProofPages?.({ limit: 3 });
        if (!batch) {
          throw new Error("sqlite store does not expose bounded card proof pages");
        }
        for (const entry of batch) {
          const single = await stores.cards.lookupCardProofPage?.(entry.card.id, { limit: 3 });
          expect(entry).toEqual(single);
        }
      } finally {
        stores.close();
      }
    });
  });
});
