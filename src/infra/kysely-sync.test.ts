// Covers the compile-only Kysely facade used by sync node:sqlite helpers.
import { DatabaseSync } from "node:sqlite";
import type { Generated } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";

type SyncHelperTestDatabase = {
  items: {
    id: Generated<number>;
    name: string;
  };
};

describe("kysely sync helpers", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    if (!database) {
      return;
    }
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
    database = undefined;
  });

  it("executes compiled queries through the sync helpers", () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      "create table items (id integer primary key autoincrement, name text not null unique)",
    );
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);

    const insertResult = executeSqliteQuerySync(
      database,
      db.insertInto("items").values({ name: "Ada" }),
    );
    expect(insertResult.insertId).toBe(1n);
    expect(insertResult.numAffectedRows).toBe(1n);

    expect(
      executeSqliteQuerySync(
        database,
        db.insertInto("items").values({ name: "Grace" }).returning(["id", "name"]),
      ).rows,
    ).toEqual([{ id: 2, name: "Grace" }]);

    const select = db.selectFrom("items").selectAll().orderBy("id");
    expect(executeSqliteQueryTakeFirstSync(database, select)).toEqual({ id: 1, name: "Ada" });
    expect([...iterateSqliteQuerySync(database, select)]).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ]);
  });

  it("keeps the builder facade compile-only and fails direct execution", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("create table items (id integer primary key, name text not null)");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);

    executeSqliteQuerySync(database, db.insertInto("items").values({ id: 1, name: "Ada" }));
    expect(executeSqliteQuerySync(database, db.selectFrom("items").selectAll()).rows).toEqual([
      { id: 1, name: "Ada" },
    ]);

    const compileOnlyError = /compile-only Kysely facade/;
    await expect(db.selectFrom("items").selectAll().execute()).rejects.toThrow(compileOnlyError);
    await expect(db.insertInto("items").values({ id: 2, name: "Grace" }).execute()).rejects.toThrow(
      compileOnlyError,
    );
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("items").values({ id: 3, name: "Lin" }).execute();
      }),
    ).rejects.toThrow(compileOnlyError);
    await expectCompileOnlyRejection(db.startTransaction().execute());
    await expectCompileOnlyRejection(consumeStream(db.selectFrom("items").selectAll().stream()));
    await expectCompileOnlyRejection(db.selectFrom("items").selectAll().execute());

    expect(
      executeSqliteQuerySync(database, db.selectFrom("items").select(["id", "name"])).rows,
    ).toEqual([{ id: 1, name: "Ada" }]);
  });
});

async function expectCompileOnlyRejection(promise: Promise<unknown>): Promise<void> {
  await expect(Promise.race([promise, timeoutAfter(500)])).rejects.toThrow(
    /compile-only Kysely facade/,
  );
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("timed out waiting for compile-only rejection")), ms);
  });
}

async function consumeStream<Row>(stream: AsyncIterableIterator<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of stream) {
    rows.push(row);
  }
  return rows;
}
