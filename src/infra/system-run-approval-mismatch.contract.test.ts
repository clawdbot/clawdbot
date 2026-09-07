// Verifies serialized system-run approval mismatch contract fixtures.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  toSystemRunApprovalMismatchError,
  type SystemRunApprovalMatchResult,
} from "./system-run-approval-binding.js";

type FixtureCase = {
  name: string;
  runId: string;
  match: Extract<SystemRunApprovalMatchResult, { ok: false }>;
  expected: {
    ok: false;
    message: string;
    details: Record<string, unknown>;
  };
};

type Fixture = {
  cases: FixtureCase[];
};

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/system-run-approval-mismatch-contract.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

describe("system-run approval mismatch contract fixtures", () => {
  test.each(fixture.cases)("$name", (entry) => {
    const result = toSystemRunApprovalMismatchError({
      runId: entry.runId,
      match: entry.match,
    });
    expect(result).toEqual(entry.expected);
  });
});
