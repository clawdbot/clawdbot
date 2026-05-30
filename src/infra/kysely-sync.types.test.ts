import type { DatabaseSync } from "node:sqlite";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type TypeTestDatabase = {
  type_test_items: {
    id: number;
    name: string | null;
    data: Uint8Array;
  };
};

describe("kysely sync helper types", () => {
  it("preserves Kysely builder result rows through sync helpers", () => {
    const nativeDb = {} as DatabaseSync;
    const db = getNodeSqliteKysely<TypeTestDatabase>(nativeDb);
    const query = db
      .selectFrom("type_test_items")
      .select((eb) => ["id as itemId", "name", "data", eb.fn.countAll<number>().as("total")])
      .groupBy(["id", "name", "data"]);

    const assertTypes = () => {
      const result = executeSqliteQuerySync(nativeDb, query);
      expectTypeOf(result.rows).toEqualTypeOf<
        Array<{
          itemId: number;
          name: string | null;
          data: Uint8Array;
          total: number;
        }>
      >();

      const row = executeSqliteQueryTakeFirstSync(nativeDb, query);
      expectTypeOf(row).toEqualTypeOf<
        | {
            itemId: number;
            name: string | null;
            data: Uint8Array;
            total: number;
          }
        | undefined
      >();

      // @ts-expect-error Kysely checks selected column string literals.
      db.selectFrom("type_test_items").select("missing_column");

      // @ts-expect-error Kysely checks table string literals.
      db.selectFrom("missing_table").selectAll();

      // @ts-expect-error Kysely checks where-reference string literals.
      db.selectFrom("type_test_items").select("id").where("missing_column", "=", 1);

      // @ts-expect-error Kysely checks grouped column string literals.
      query.groupBy("missing_column");

      // @ts-expect-error Kysely checks order references and selected aliases.
      query.orderBy("missingAlias");
    };
    void assertTypes;

    expect(query.compile().sql).toContain("select");
  });
});
