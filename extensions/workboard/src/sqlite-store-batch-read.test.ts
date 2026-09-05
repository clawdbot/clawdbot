// Workboard tests cover the sqlite batch card read path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardNotificationSubscription,
} from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

const sqliteStatements = vi.hoisted(() => ({ count: 0 }));

vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        for (const method of ["all", "get", "iterate", "run"] as const) {
          Object.defineProperty(statement, method, {
            value: new Proxy(statement[method], {
              apply(target, receiver, methodArgs) {
                sqliteStatements.count++;
                return Reflect.apply(target, receiver, methodArgs);
              },
            }),
          });
        }
        return statement;
      });
      return db;
    },
  };
});

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
        { id: `${id}-link`, type: "relates_to", url: "https://example.test", createdAt: 1000 },
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

  it("reads each keyed collection once while preserving rows, binary order, and attachment joins", async () => {
    await withStores(async (dbPath) => {
      let stores = createWorkboardSqliteStores({ dbPath });
      // SQLite's binary order differs from locale sorting and from UTF-16 for the last two ids.
      const ids = ["Z", "a", "Å", "ä", "é", "中", "\uE000", "😀"];
      const boards: PersistedWorkboardBoard[] = ids.map((id, index) => ({
        version: 1,
        board: {
          id,
          createdAt: index,
          updatedAt: 30,
          ...(index % 2
            ? {
                name: `Board ${id}`,
                automationJobId: `job-${id}`,
                defaultWorkspace: { kind: "scratch" as const },
                orchestration: { autoDecompose: false },
                archivedAt: 0,
              }
            : {}),
        },
      }));
      const subscriptions: PersistedWorkboardNotificationSubscription[] = ids.map((id, index) => ({
        version: 1,
        subscription: {
          id,
          boardId: id,
          createdAt: index % 2,
          updatedAt: 30,
          ...(index % 2
            ? {
                cardId: "card-0",
                sessionKey: `session-${id}`,
                runId: `run-${id}`,
                target: `target-${id}`,
                eventKinds: [],
                lastEventAt: 0,
                lastEventId: `event-${id}`,
                lastEventSequence: 0,
                deliveredEventIds: [],
              }
            : {}),
        },
      }));
      const attachments: PersistedWorkboardAttachment[] = ids.map((id, index) => ({
        version: 1,
        attachment: {
          id,
          cardId: "card-0",
          fileName: `${id}.bin`,
          byteSize: 3,
          createdAt: index % 2,
          ...(index % 2 ? { mimeType: "application/octet-stream", note: `Note ${id}` } : {}),
        },
        contentBase64: Buffer.from([0, index, 255]).toString("base64"),
      }));
      try {
        for (const board of boards.toReversed()) {
          await stores.boards.register(board.board.id, board);
        }
        for (const subscription of subscriptions.toReversed()) {
          await stores.subscriptions.register(subscription.subscription.id, subscription);
        }
        const card = fixtureCard(0);
        card.metadata = {
          attachments: [
            ...attachments.toReversed().map((entry) => entry.attachment),
            { ...attachments[0]!.attachment, id: "metadata-without-blob" },
          ],
        };
        await stores.cards.register(card.id, { version: 1, card });
        for (const attachment of attachments.toReversed()) {
          await stores.attachments.register(attachment.attachment.id, attachment);
        }
        await stores.attachments.register("blob-without-metadata", {
          ...attachments[0]!,
          attachment: { ...attachments[0]!.attachment, id: "blob-without-metadata" },
        });
        stores.close();
        stores = createWorkboardSqliteStores({ dbPath });

        const beforeBoards = sqliteStatements.count;
        const boardEntries = await stores.boards.entries();
        const boardReads = sqliteStatements.count - beforeBoards;
        const beforeSubscriptions = sqliteStatements.count;
        const subscriptionEntries = await stores.subscriptions.entries();
        const subscriptionReads = sqliteStatements.count - beforeSubscriptions;
        const beforeAttachments = sqliteStatements.count;
        const attachmentEntries = await stores.attachments.entries();
        const attachmentReads = sqliteStatements.count - beforeAttachments;

        expect(boardEntries).toEqual(boards.map((value) => ({ key: value.board.id, value })));
        const timeOrder = [0, 2, 4, 6, 1, 3, 5, 7];
        expect(subscriptionEntries).toEqual(
          timeOrder.map((index) => ({ key: ids[index], value: subscriptions[index] })),
        );
        expect(attachmentEntries).toEqual(
          timeOrder.map((index) => ({ key: ids[index], value: attachments[index] })),
        );
        for (const [collection, entries] of [
          [stores.boards, boardEntries],
          [stores.subscriptions, subscriptionEntries],
          [stores.attachments, attachmentEntries],
        ] as const) {
          for (const { key, value } of entries) {
            await expect(collection.lookup(key)).resolves.toEqual(value);
          }
          await expect(collection.lookup("missing")).resolves.toBeUndefined();
        }
        expect({ boardReads, subscriptionReads, attachmentReads }).toEqual({
          boardReads: 1,
          subscriptionReads: 1,
          attachmentReads: 1,
        });
      } finally {
        stores.close();
      }
    });
  });

  it.each([
    { kind: "boards", table: "workboard_boards", column: "default_workspace_json" },
    {
      kind: "subscriptions",
      table: "workboard_notification_subscriptions",
      column: "event_kinds_json",
    },
  ] as const)("preserves empty and malformed JSON handling for $kind", async (testCase) => {
    await withStores(async (dbPath) => {
      const stores = createWorkboardSqliteStores({ dbPath });
      const raw = new DatabaseSync(dbPath);
      try {
        const board: PersistedWorkboardBoard = {
          version: 1,
          board: { id: "row", createdAt: 1, updatedAt: 2 },
        };
        const subscription: PersistedWorkboardNotificationSubscription = {
          version: 1,
          subscription: { id: "row", boardId: "default", createdAt: 1, updatedAt: 2 },
        };
        await stores.boards.register("row", board);
        await stores.subscriptions.register("row", subscription);
        const collection = stores[testCase.kind];
        const expected = testCase.kind === "boards" ? board : subscription;
        raw.prepare(`UPDATE ${testCase.table} SET ${testCase.column} = ?`).run("");
        await expect(collection.lookup("row")).resolves.toEqual(expected);
        await expect(collection.entries()).resolves.toEqual([{ key: "row", value: expected }]);

        raw.prepare(`UPDATE ${testCase.table} SET ${testCase.column} = ?`).run("{");
        await expect(collection.lookup("row")).rejects.toThrow(SyntaxError);
        await expect(collection.entries()).rejects.toThrow(SyntaxError);
      } finally {
        raw.close();
        stores.close();
      }
    });
  });
});
