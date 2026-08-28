import { describe, expect, it } from "vitest";
import { createCommandError } from "./command-error.js";
import type { SpawnResult } from "./exec-result.js";

const failure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 124,
  signal: null,
  killed: true,
  termination: "timeout",
};

describe("createCommandError", () => {
  it.each([
    { termination: "timeout", expected: "timed out after 3 seconds" },
    { termination: "no-output-timeout", expected: "timed out waiting for output" },
    { termination: "signal", expected: "terminated" },
  ] as const)("reports $termination without inventing a signal or Git advice", (entry) => {
    const error = createCommandError(
      "setup",
      { ...failure, termination: entry.termination, code: null },
      { timeoutMs: 3_000 },
    );
    expect(error.message).toBe(`setup failed (${entry.expected})`);
  });

  it("bounds labels and diagnostic tails without splitting surrogate pairs", () => {
    const command = `\u001b[31m${"x".repeat(254)}\r\n🦞${"y".repeat(300)}\u001b[0m`;
    const stderr = `${"x".repeat(100)}🦞${"y".repeat(1999)}`;
    const error = createCommandError(command, { ...failure, stderr }, { timeoutMs: 120_000 });

    const [label, detail] = error.message.split(" failed (timed out after 120 seconds):\n");
    expect(label).toBe(`${"x".repeat(254)} `);
    expect(detail).toBe(`…\n${"y".repeat(1999)}`);
  });
});
