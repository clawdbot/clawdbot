import { DatabaseSync } from "node:sqlite";
import { CompiledQuery, Kysely, sql, type Generated } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeSqliteKyselyDialect } from "./kysely-node-sqlite.js";

type TestDatabase = {
  person: {
    id: Generated<number>;
    name: string;
  };
};

describe("NodeSqliteKyselyDialect", () => {
  let db: Kysely<TestDatabase> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  it("uses node:sqlite with raw row-returning queries and returning clauses", async () => {
    db = await createTestDb();

    await expect(db.selectFrom("person").selectAll().execute()).resolves.toEqual([
      { id: 1, name: "Ada" },
    ]);
    await expect(sql`select name from person where id = ${1}`.execute(db)).resolves.toEqual({
      rows: [{ name: "Ada" }],
    });
    await expect(
      db.insertInto("person").values({ name: "Grace" }).returning(["id", "name"]).execute(),
    ).resolves.toEqual([{ id: 2, name: "Grace" }]);
    await expect(
      sql`insert into person (name) values ('Lin') returning *`.execute(db),
    ).resolves.toEqual({
      rows: [{ id: 3, name: "Lin" }],
    });

    const ignoredInsert = await sql`
      insert or ignore into person (id, name) values (${1}, ${"Ada Again"})
    `.execute(db);
    expect(ignoredInsert.insertId).toBeUndefined();
    expect(ignoredInsert.numAffectedRows).toBe(0n);

    const update = await sql`update person set name = ${"Ada Lovelace"} where id = ${1}`.execute(
      db,
    );
    expect(update.insertId).toBeUndefined();
    expect(update.numAffectedRows).toBe(1n);
  });

  it("creates the database lazily and runs the connection hook once", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const createDatabase = vi.fn(() => sqlite);
    const onCreateConnection = vi.fn(async (connection) => {
      await connection.executeQuery(CompiledQuery.raw("pragma user_version = 7"));
    });

    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: createDatabase,
        onCreateConnection,
      }),
    });

    await expect(sql<{ user_version: number }>`pragma user_version`.execute(db)).resolves.toEqual({
      rows: [{ user_version: 7 }],
    });
    expect(createDatabase).toHaveBeenCalledTimes(1);
    expect(onCreateConnection).toHaveBeenCalledTimes(1);
  });

  it("returns insert metadata only for changed insert statements", async () => {
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: new DatabaseSync(":memory:"),
      }),
    });
    await createPersonTable(db);

    const insertResult = await db
      .insertInto("person")
      .values({ name: "Ada" })
      .executeTakeFirstOrThrow();
    expect(insertResult.insertId).toBe(1n);
    expect(insertResult.numInsertedOrUpdatedRows).toBe(1n);

    const updateResult = await db
      .updateTable("person")
      .set({ name: "Ada Lovelace" })
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    expect(updateResult.numUpdatedRows).toBe(1n);

    const ignoredInsert = await sql`
      insert or ignore into person (id, name) values (${1}, ${"Ada Again"})
    `.execute(db);
    expect(ignoredInsert.insertId).toBeUndefined();
    expect(ignoredInsert.numAffectedRows).toBe(0n);
  });

  it("rolls back transactions and controlled savepoints", async () => {
    db = new Kysely<TestDatabase>({
      dialect: new NodeSqliteKyselyDialect({
        database: new DatabaseSync(":memory:"),
      }),
    });
    await createPersonTable(db);

    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto("person").values({ name: "Rollback" }).execute();
        throw new Error("rollback outer");
      }),
    ).rejects.toThrow("rollback outer");
    await expect(db.selectFrom("person").selectAll().execute()).resolves.toStrictEqual([]);

    const trx = await db.startTransaction().execute();
    await trx.insertInto("person").values({ name: "Ada" }).execute();
    const afterAda = await trx.savepoint("after_ada").execute();
    await afterAda.insertInto("person").values({ name: "Grace" }).execute();
    const afterRollback = await afterAda.rollbackToSavepoint("after_ada").execute();
    await afterRollback.insertInto("person").values({ name: "Lin" }).execute();
    await afterRollback.commit().execute();

    await expect(db.selectFrom("person").select("name").orderBy("id").execute()).resolves.toEqual([
      { name: "Ada" },
      { name: "Lin" },
    ]);
  });

  it("streams selected rows through node:sqlite iteration", async () => {
    db = await createTestDb();
    await db
      .insertInto("person")
      .values([{ name: "Grace" }, { name: "Lin" }])
      .execute();

    const rows: Array<{ id: number; name: string }> = [];
    for await (const row of db.selectFrom("person").selectAll().orderBy("id").stream(1)) {
      rows.push(row);
    }

    expect(rows).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
      { id: 3, name: "Lin" },
    ]);
  });
});

async function createTestDb(): Promise<Kysely<TestDatabase>> {
  const testDb = new Kysely<TestDatabase>({
    dialect: new NodeSqliteKyselyDialect({
      database: new DatabaseSync(":memory:"),
    }),
  });
  await createPersonTable(testDb);
  await testDb.insertInto("person").values({ name: "Ada" }).execute();
  return testDb;
}

async function createPersonTable(testDb: Kysely<TestDatabase>): Promise<void> {
  await testDb.schema
    .createTable("person")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();
}
