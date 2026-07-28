// Covers the compile-only Kysely facade used by sync node:sqlite helpers.
import { spawnSync } from "node:child_process";
import { constants, DatabaseSync } from "node:sqlite";
import { sql, type Generated } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
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

  it("returns identical results while repeated statements move from cold to warm", () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      "create table items (id integer primary key autoincrement, name text not null unique)",
    );
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const prepares = countPrepares(database);

    const insertResults = ["Ada", "Grace", "Lin"].map((name) =>
      executeSqliteQuerySync(database!, db.insertInto("items").values({ name })),
    );
    expect(insertResults).toEqual([
      { insertId: 1n, numAffectedRows: 1n, rows: [] },
      { insertId: 2n, numAffectedRows: 1n, rows: [] },
      { insertId: 3n, numAffectedRows: 1n, rows: [] },
    ]);
    expect(prepares.calls()).toBe(2);

    const select = db.selectFrom("items").selectAll().orderBy("id");
    const expectedRows = [
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ];
    expect(executeSqliteQuerySync(database, select).rows).toEqual(expectedRows);
    expect(executeSqliteQuerySync(database, select).rows).toEqual(expectedRows);
    expect(executeSqliteQuerySync(database, select).rows).toEqual(expectedRows);
    expect(prepares.calls()).toBe(4);

    const conflictingInsert = db.insertInto("items").values({ id: 1, name: "Duplicate" });
    const errors = Array.from({ length: 3 }, () => {
      try {
        executeSqliteQuerySync(database!, conflictingInsert);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return { message: (error as Error).message, name: (error as Error).name };
      }
    });
    expect(errors[0]).not.toBeNull();
    expect(errors[1]).toEqual(errors[0]);
    expect(errors[2]).toEqual(errors[0]);
    expect(prepares.calls()).toBe(6);
  });

  it("admits only repeated SQL and bounds the prepared statement working set", () => {
    database = new DatabaseSync(":memory:");
    database.exec("create table items (id integer primary key, name text not null)");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const prepares = countPrepares(database);
    const variableSelect = (parameterCount: number) =>
      db
        .selectFrom("items")
        .selectAll()
        .where(
          "id",
          "not in",
          Array.from({ length: parameterCount }, (_, index) => index + 1),
        );

    for (let parameterCount = 1; parameterCount <= 64; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(128);

    for (let parameterCount = 33; parameterCount <= 64; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(128);

    for (let parameterCount = 1; parameterCount <= 32; parameterCount += 1) {
      expect(executeSqliteQuerySync(database, variableSelect(parameterCount)).rows).toEqual([]);
    }
    expect(prepares.calls()).toBe(160);
  });

  it("does not retain one-shot variable-cardinality SQL statements", () => {
    database = new DatabaseSync(":memory:");
    database.exec("create table items (id integer primary key, name text not null)");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const prepares = countPrepares(database);
    const runVariableSelects = () => {
      for (let parameterCount = 1; parameterCount <= 64; parameterCount += 1) {
        const ids = Array.from({ length: parameterCount }, (_, index) => index + 1);
        const select = db.selectFrom("items").selectAll().where("id", "not in", ids);
        expect(executeSqliteQuerySync(database!, select).rows).toEqual([]);
      }
    };

    runVariableSelects();
    runVariableSelects();
    runVariableSelects();
    expect(prepares.calls()).toBe(192);
  });

  it("keeps nested lazy iterations independent", () => {
    database = new DatabaseSync(":memory:");
    database.exec(
      "create table items (id integer primary key autoincrement, name text not null unique)",
    );
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    for (const name of ["Ada", "Grace", "Lin"]) {
      executeSqliteQuerySync(database, db.insertInto("items").values({ name }));
    }
    const select = db.selectFrom("items").selectAll().orderBy("id");
    const prepares = countPrepares(database);

    expect([...iterateSqliteQuerySync(database, select)]).toHaveLength(3);
    expect([...iterateSqliteQuerySync(database, select)]).toHaveLength(3);

    const outer = iterateSqliteQuerySync(database, select);
    expect(outer.next()).toEqual({ done: false, value: { id: 1, name: "Ada" } });
    expect([...iterateSqliteQuerySync(database, select)]).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
    expect([...outer]).toEqual([
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
    expect(prepares.calls()).toBe(4);
  });

  it("does not reuse an active cached statement during synchronous callback re-entry", () => {
    database = new DatabaseSync(":memory:");
    let nested = false;
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const query = db.selectNoFrom(
      /* kysely-allow-raw: cache re-entry test needs a synthetic UDF call, not a store column. */
      sql<number>`nested_value()`.as("value"),
    );
    database.function("nested_value", () => {
      if (nested) {
        return 1;
      }
      nested = true;
      try {
        return executeSqliteQueryTakeFirstSync(database!, query)!.value + 1;
      } finally {
        nested = false;
      }
    });
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, query).rows).toEqual([{ value: 2 }]);
    expect(executeSqliteQuerySync(database, query).rows).toEqual([{ value: 2 }]);
    expect(executeSqliteQuerySync(database, query).rows).toEqual([{ value: 2 }]);
    expect(prepares.calls()).toBe(4);
  });

  it("invalidates prepared statements when the SQLite authorizer changes", () => {
    database = new DatabaseSync(":memory:");
    if (typeof database.setAuthorizer !== "function") {
      return;
    }
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(2);

    database.setAuthorizer((actionCode, tableName) =>
      actionCode === constants.SQLITE_READ && tableName === "items"
        ? constants.SQLITE_IGNORE
        : constants.SQLITE_OK,
    );
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: null, name: null }]);
    expect(prepares.calls()).toBe(5);

    database.setAuthorizer(null);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(6);
  });

  it("does not cache while a dynamic SQLite authorizer is installed", () => {
    database = new DatabaseSync(":memory:");
    if (typeof database.setAuthorizer !== "function") {
      return;
    }
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);
    let allow = true;
    database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(3);

    allow = false;
    expect(() => executeSqliteQuerySync(database!, select)).toThrow(/not authorized/iu);
    expect(prepares.calls()).toBe(4);
  });

  it("does not retain oversized statement parameters", () => {
    database = new DatabaseSync(":memory:");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const lengthOf = (value: string) =>
      db.selectNoFrom(
        /* kysely-allow-raw: parameter-retention test measures binding size on a scalar, schema-free query. */
        sql<number>`length(${value})`.as("value"),
      );
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(prepares.calls()).toBe(2);

    const oversized = "x".repeat(64 * 1024 + 1);
    expect(executeSqliteQuerySync(database, lengthOf(oversized)).rows).toEqual([
      { value: oversized.length },
    ]);
    expect(prepares.calls()).toBe(3);
    expect(executeSqliteQuerySync(database, lengthOf("small")).rows).toEqual([{ value: 5 }]);
    expect(prepares.calls()).toBe(3);

    const oversizedSql = db.selectNoFrom(
      /* kysely-allow-raw: admission-gate test needs an oversized SQL text, only reachable via raw. */
      sql.raw<number>(`1 /*${"x".repeat(64 * 1024)}*/`).as("value"),
    );
    expect(executeSqliteQuerySync(database, oversizedSql).rows).toEqual([{ value: 1 }]);
    expect(executeSqliteQuerySync(database, oversizedSql).rows).toEqual([{ value: 1 }]);
    expect(prepares.calls()).toBe(5);
  });

  it("invalidates prepared statements when the database is deserialized", () => {
    database = new DatabaseSync(":memory:");
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    let replacementBytes = new Uint8Array();
    if (typeof database.deserialize === "function") {
      const replacement = new DatabaseSync(":memory:");
      replacement.exec("create table items (id integer primary key, name text not null)");
      replacement.exec("insert into items (id, name) values (2, 'Grace')");
      replacementBytes = replacement.serialize();
      replacement.close();
    } else {
      Object.defineProperty(database, "deserialize", {
        configurable: true,
        value(this: DatabaseSync): void {
          this.exec("delete from items");
          this.exec("insert into items (id, name) values (2, 'Grace')");
        },
      });
    }
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(2);

    database.deserialize(replacementBytes);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 2, name: "Grace" }]);
    expect(prepares.calls()).toBe(3);
  });

  it("refreshes cached query metadata after a schema change", () => {
    database = new DatabaseSync(":memory:");
    database.exec("create table items (id integer primary key, name text not null)");
    database.exec("insert into items (id, name) values (1, 'Ada')");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const select = db.selectFrom("items").selectAll();
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(executeSqliteQuerySync(database, select).rows).toEqual([{ id: 1, name: "Ada" }]);
    expect(prepares.calls()).toBe(2);

    database.exec("alter table items add column note text not null default 'new'");

    expect(executeSqliteQuerySync(database, select).rows).toEqual([
      { id: 1, name: "Ada", note: "new" },
    ]);
    expect(prepares.calls()).toBe(2);
  });

  it("resets a cached row statement after a step-time error", () => {
    database = new DatabaseSync(":memory:");
    const db = getNodeSqliteKysely<SyncHelperTestDatabase>(database);
    const jsonValue = (value: string) =>
      db.selectNoFrom(
        /* kysely-allow-raw: step-error test needs json() to fail at execution time, not prepare time. */
        sql<string>`json(${value})`.as("value"),
      );
    const prepares = countPrepares(database);

    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(executeSqliteQuerySync(database, jsonValue("{}")).rows).toEqual([{ value: "{}" }]);
    expect(prepares.calls()).toBe(2);

    expect(() => executeSqliteQuerySync(database!, jsonValue("{"))).toThrow(/malformed JSON/iu);
    expect(executeSqliteQuerySync(database, jsonValue("[]")).rows).toEqual([{ value: "[]" }]);
    expect(prepares.calls()).toBe(2);
  });

  it("allows databases and prepared statements to collect after lifecycle clearing", () => {
    expect(runRetentionScenario({ clearBeforeDrop: true })).toEqual({
      databaseCollected: true,
      statementsCollected: 2,
      statementCount: 2,
    });
  });

  it("retains a cached database when lifecycle clearing is skipped", () => {
    expect(runRetentionScenario({ clearBeforeDrop: false })).toEqual({
      databaseCollected: false,
      statementsCollected: 1,
      statementCount: 2,
    });
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

function countPrepares(database: DatabaseSync): { calls: () => number } {
  enableNodeSqliteKyselyStatementCache(database);
  const originalPrepare = database.prepare.bind(database);
  let calls = 0;
  database.prepare = (sqlText, options) => {
    calls += 1;
    return originalPrepare(sqlText, options);
  };
  return { calls: () => calls };
}

function runRetentionScenario(options: { clearBeforeDrop: boolean }): {
  databaseCollected: boolean;
  statementsCollected: number;
  statementCount: number;
} {
  const moduleUrl = new URL("./kysely-sync.ts", import.meta.url).href;
  const cleanup = options.clearBeforeDrop
    ? `
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      `
    : "";
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import {
      clearNodeSqliteKyselyCacheForDatabase,
      enableNodeSqliteKyselyStatementCache,
      executeSqliteQuerySync,
      getNodeSqliteKysely,
    } from ${JSON.stringify(moduleUrl)};

    const waitForTurn = () => new Promise((resolve) => setImmediate(resolve));
    async function runScenario() {
      let database = new DatabaseSync(":memory:");
      database.exec("create table items (id integer primary key, name text not null)");
      const databaseRef = new WeakRef(database);
      const statementRefs = [];
      const originalPrepare = DatabaseSync.prototype.prepare;
      database.prepare = function (sql, prepareOptions) {
        const statement = originalPrepare.call(this, sql, prepareOptions);
        statementRefs.push(new WeakRef(statement));
        return statement;
      };
      const db = getNodeSqliteKysely(database);
      enableNodeSqliteKyselyStatementCache(database);
      const select = db.selectFrom("items").selectAll().orderBy("id");
      executeSqliteQuerySync(database, select);
      executeSqliteQuerySync(database, select);
      executeSqliteQuerySync(database, select);
      delete database.prepare;
      ${cleanup}
      database = undefined;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        await waitForTurn();
        globalThis.gc();
      }
      return {
        databaseCollected: databaseRef.deref() === undefined,
        statementsCollected: statementRefs.filter((ref) => ref.deref() === undefined).length,
        statementCount: statementRefs.length,
      };
    }

    process.stdout.write(JSON.stringify(await runScenario()));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    databaseCollected: boolean;
    statementsCollected: number;
    statementCount: number;
  };
}

async function expectCompileOnlyRejection(promise: Promise<unknown>): Promise<void> {
  await expect(
    withTestTimeout(promise, 500, "timed out waiting for compile-only rejection"),
  ).rejects.toThrow(/compile-only Kysely facade/);
}

async function consumeStream<Row>(stream: AsyncIterableIterator<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of stream) {
    rows.push(row);
  }
  return rows;
}
