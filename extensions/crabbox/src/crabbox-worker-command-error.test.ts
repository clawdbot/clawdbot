import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import {
  crabboxCommandError,
  permanentCrabboxCommandError,
} from "./crabbox-worker-command-error.js";

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("crabboxCommandError", () => {
  it("keeps short provider output intact", () => {
    const error = crabboxCommandError(
      "warmup",
      commandResult({ code: 2, stderr: "provider=aws quota exhausted" }),
    );
    expect(error.message).toBe(
      "Crabbox warmup failed with exit code 2: provider=aws quota exhausted",
    );
  });

  it("falls back to stdout when stderr is empty", () => {
    const error = crabboxCommandError("inspect", commandResult({ code: 1, stdout: "quota page" }));
    expect(error.message).toBe("Crabbox inspect failed with exit code 1: quota page");
  });

  it("omits output detail when the command did not exit", () => {
    const error = crabboxCommandError(
      "inspect",
      commandResult({ code: null, killed: true, termination: "timeout", stderr: "partial" }),
    );
    expect(error.message).toBe("Crabbox inspect did not exit normally (timeout)");
  });

  it("keeps the failure reason at the tail of long provider output", () => {
    const progress = "pulling layer 9/12".padEnd(900, ".");
    const reason = "terminal reason: instance profile not authorized";
    const error = crabboxCommandError(
      "warmup",
      commandResult({ code: 2, stderr: `${progress}\n${reason}` }),
    );
    expect(error.message.startsWith("Crabbox warmup failed with exit code 2: …")).toBe(true);
    expect(error.message.endsWith(reason)).toBe(true);
    expect(error.message).not.toContain("pulling layer");
  });

  it("leaves 512-character output unmarked", () => {
    const detail = "x".repeat(512);
    const error = crabboxCommandError("inspect", commandResult({ code: 1, stderr: detail }));
    expect(error.message).toBe(`Crabbox inspect failed with exit code 1: ${detail}`);
  });

  it("bounds the kept detail to 512 characters including the marker", () => {
    const prefix = "Crabbox inspect failed with exit code 1: ";
    const error = crabboxCommandError(
      "inspect",
      commandResult({ code: 1, stderr: "y".repeat(2000) }),
    );
    const kept = error.message.slice(prefix.length);
    expect(kept).toHaveLength(512);
    expect(kept.startsWith("…")).toBe(true);
    expect(kept.endsWith("y".repeat(511))).toBe(true);
  });

  it("does not leave a dangling surrogate half at the cut boundary", () => {
    // The cut lands on the low surrogate of the emoji; the pair must be dropped whole.
    const stderr = `${"a".repeat(599)}\u{1F600}${"b".repeat(510)}`;
    const error = crabboxCommandError("setup", commandResult({ code: 7, stderr }));
    expect(error.message).not.toContain("\u{1F600}");
    expect(error.message.endsWith("b".repeat(510))).toBe(true);
  });
});

describe("permanentCrabboxCommandError", () => {
  it("carries the same message as the retryable variant", () => {
    const error = permanentCrabboxCommandError(
      "setup",
      commandResult({ code: 7, stderr: "apt exploded" }),
    );
    expect(error.message).toBe("Crabbox setup failed with exit code 7: apt exploded");
  });
});
