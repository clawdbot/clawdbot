import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { replaceMemoryVectorRow } from "./manager-vector-write.js";

describe("memory vector dedupe", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("deletes existing vector rows before inserting replacements", () => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");

    replaceMemoryVectorRow({
      db,
      id: "chunk-1",
      embedding: [1, 0, 0],
    });

    db.exec(`
      CREATE TRIGGER fail_if_vector_row_not_deleted
      BEFORE INSERT ON chunks_vec
      WHEN EXISTS (SELECT 1 FROM chunks_vec WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(FAIL, 'vector row not deleted before insert');
      END;
    `);

    expect(
      replaceMemoryVectorRow({
        db,
        id: "chunk-1",
        embedding: [2, 0, 0],
      }),
    ).toBeUndefined();

    const row = db
      .prepare("SELECT COUNT(*) as c, length(embedding) as bytes FROM chunks_vec WHERE id = ?")
      .get("chunk-1") as { c: number; bytes: number } | undefined;
    expect(row?.c).toBe(1);
    expect(row?.bytes).toBe(12);
  });
});
