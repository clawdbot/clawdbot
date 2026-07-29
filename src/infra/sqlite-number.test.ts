// Tests for SQLite number normalization.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { normalizeSqliteNumber } from "./sqlite-number.js";

describe("normalizeSqliteNumber", () => {
  it("returns number value unchanged", () => {
    expect(normalizeSqliteNumber(5)).toBe(5);
  });

  it("converts bigint to number", () => {
    expect(normalizeSqliteNumber(BigInt(5))).toBe(5);
  });

  it("returns undefined for null", () => {
    expect(normalizeSqliteNumber(null)).toBeUndefined();
  });

  it("returns zero unchanged", () => {
    expect(normalizeSqliteNumber(0)).toBe(0);
  });

  it("returns negative value unchanged", () => {
    expect(normalizeSqliteNumber(-1)).toBe(-1);
  });

  it("returns NaN unchanged", () => {
    expect(normalizeSqliteNumber(Number.NaN)).toBe(Number.NaN);
  });

  it("converts large bigint", () => {
    expect(normalizeSqliteNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("converts zero bigint", () => {
    expect(normalizeSqliteNumber(BigInt(0))).toBe(0);
  });

  it("converts negative bigint", () => {
    expect(normalizeSqliteNumber(BigInt(-1))).toBe(-1);
  });

  it.each([
    BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
    BigInt(-Number.MAX_SAFE_INTEGER) - BigInt(1),
  ])("returns undefined for unsafe bigint row %s", (value) => {
    const database = new DatabaseSync(":memory:");
    try {
      const statement = database.prepare("SELECT ? AS value");
      statement.setReadBigInts(true);
      const row = statement.get(value) as { value: bigint };
      expect(normalizeSqliteNumber(row.value)).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
