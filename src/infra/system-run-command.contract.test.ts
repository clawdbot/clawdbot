// Verifies system-run command contract fixtures.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveSystemRunCommandRequest } from "./system-run-command.js";

type ContractFixture = {
  cases: ContractCase[];
};

type ContractCase = {
  name: string;
  command: string[];
  rawCommand?: string;
  expected: {
    valid: boolean;
    displayCommand?: string;
    errorContains?: string;
  };
};

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/system-run-command-contract.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ContractFixture;

function expectResolvedCommandCase(entry: ContractCase): void {
  const result = resolveSystemRunCommandRequest({
    command: entry.command,
    rawCommand: entry.rawCommand,
  });

  if (!entry.expected.valid) {
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected validation failure");
    }
    if (entry.expected.errorContains) {
      expect(result.message).toContain(entry.expected.errorContains);
    }
    return;
  }

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`unexpected validation failure: ${result.message}`);
  }
  expect(result.commandText).toBe(entry.expected.displayCommand);
}

describe("system-run command contract fixtures", () => {
  test.each(fixture.cases)("$name", (entry) => {
    expectResolvedCommandCase(entry);
  });
});
