import { describe, expect, it } from "vitest";
import { resolveSqliteIntegrityTimeoutMs } from "./sqlite-readonly-worker.js";

describe("resolveSqliteIntegrityTimeoutMs", () => {
  it.each(
    [
      { label: "0 B", sizeBytes: 0, expected: 30_000 },
      { label: "1 B", sizeBytes: 1, expected: 31_000 },
      { label: "32 MiB", sizeBytes: 32 * 1024 * 1024, expected: 31_000 },
      { label: "32 MiB + 1 B", sizeBytes: 32 * 1024 * 1024 + 1, expected: 32_000 },
      { label: "300 MiB", sizeBytes: 300 * 1024 * 1024, expected: 40_000 },
      { label: "9.4 GiB", sizeBytes: Math.floor(9.4 * 1024 ** 3), expected: 331_000 },
      { label: "64 GiB (capped)", sizeBytes: 64 * 1024 ** 3, expected: 1_800_000 },
      { label: "huge file (capped)", sizeBytes: Number.MAX_SAFE_INTEGER, expected: 1_800_000 },
    ].flatMap((testCase) => [
      { ...testCase, inputType: "number" },
      { ...testCase, inputType: "bigint", sizeBytes: BigInt(testCase.sizeBytes) },
    ]),
  )("budgets $label ($inputType)", ({ sizeBytes, expected }) => {
    expect(resolveSqliteIntegrityTimeoutMs(sizeBytes)).toBe(expected);
  });
});
