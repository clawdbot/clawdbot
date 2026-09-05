import { describe, expect, it } from "vitest";
import { createCommandError, formatCommandOutput, formatCommandResult } from "./command-error.js";
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

it.each([false, true])("retains both diagnostics when outputs are buffers: %s", (buffered) => {
  const text: SpawnResult = {
    ...failure,
    code: 23,
    killed: false,
    termination: "exit",
    stdout: "Setup cannot continue: create local-fixture-input.txt and retry.\n",
    stderr: "Warning: optional fixture hint is unset.\n",
  };
  const result = buffered
    ? {
        ...text,
        termination: "exit" as const,
        stdout: Buffer.from(text.stdout),
        stderr: Buffer.from(text.stderr),
      }
    : text;
  const error = createCommandError("worktree setup", result, { timeoutMs: 120_000 });
  expect(error.message).toContain("exit code 23");
  expect(error.message).toContain("create local-fixture-input.txt and retry");
  expect(error.message).toContain("optional fixture hint is unset");
  expect(error.message).toContain("stderr:");
  expect(error.message).toContain("stdout:");
  expect(error.message).not.toContain("timed out");
});

it("retains complete uneven streams when they fit within the shared budget", () => {
  const stdout = `recovery instruction: ${"x".repeat(1_200)}`;
  const error = createCommandError(
    "worktree setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout,
      stderr: "warning",
    },
    { timeoutMs: 120_000 },
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toBe(`stderr: warning\nstdout: ${stdout}`);
  expect(detail).not.toContain("…");
});

it("sanitizes terminal controls without flattening logical lines", () => {
  const error = createCommandError(
    "worktree setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout: "recovery",
      stderr: "\u001b[31mstale\rfinal\tfield\u0007\u007f\u0085\nnext\u001b[0m",
    },
    { timeoutMs: 120_000 },
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toBe("stderr: final\\tfield\nnext\nstdout: recovery");
});

it("keeps independent recent stream tails within the existing error budget", () => {
  const error = createCommandError(
    "worktree setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout: `${"old output\n".repeat(30)}${"x".repeat(3000)}\nstdout recovery 🦞`,
      stderr: `${"old warning\n".repeat(30)}${"y".repeat(3000)}\nwarning detail 🦞`,
    },
    { timeoutMs: 120_000 },
  );
  expect(error.message).toContain("stdout recovery 🦞");
  expect(error.message).toContain("warning detail 🦞");
  expect(error.message).not.toContain("old output");
  expect(error.message).not.toContain("old warning");
  expect(error.message).toContain(":\n");
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toMatch(/^stderr: …\n/u);
  expect(detail).toContain("\nstdout: …\n");
  expect(detail.length).toBeLessThanOrEqual(2_000);
  expect(detail).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  expect(detail).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  expect(error.message.length).toBeLessThan(2300);
});

it.each([
  { stdout: "stdout recovery", stderr: "", present: "stdout recovery" },
  { stdout: "", stderr: "stderr recovery", present: "stderr recovery" },
  { stdout: "stdout recovery", stderr: "\u001b[31m\u001b[0m\r\n", present: "stdout recovery" },
])("keeps single visible output %#: $present", ({ stdout, stderr, present }) => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout,
      stderr,
    },
    { timeoutMs: 120_000 },
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toBe(present);
  expect(error.message).toContain("exit code 23");
});

// Buffered capture/launch failures carry an error termination, sometimes with an exit code.
it.each([23, null])("keeps buffered error exit metadata %#", (code) => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code,
      killed: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      termination: "error",
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toBe(code === null ? "setup failed" : "setup failed (exit code 23)");
});

it.each([0, 1])("keeps zero and tiny output caps surrogate-safe %#", (maxChars) => {
  expect(formatCommandOutput("🦞", maxChars)).toBe("…\n");
});

it.each([
  { stderr: " \tstale\r\tfinal\tfield\t \n", expected: "stderr: final\\tfield\nstdout: recovery" },
  { stderr: "\u0007\u007f\u0085", expected: "recovery" },
])("keeps trim and control-only normalization %#", ({ stderr, expected }) => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stderr,
      stdout: "recovery",
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toBe(`setup failed (exit code 23):\n${expected}`);
});

it("retains a short already-omitted tail alongside the other stream", () => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stderr: Array.from({ length: 13 }, (_, index) => `note ${index}`).join("\n"),
      stdout: "recovery",
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toContain("stderr: …\nnote 1\n");
  expect(error.message).not.toContain("note 0\n");
  expect(error.message).toContain("note 12\nstdout: recovery");
  expect(error.message.match(/…/g)).toHaveLength(1);
});

it.each(["stdout", "stderr"] as const)(
  "does not widen the result %s cap for a single stream",
  (stream) => {
    const result = formatCommandResult("command", {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout: "",
      stderr: "",
      [stream]: "x".repeat(1_600),
    });
    expect(result).toContain(`${stream}:`);
    expect(result).not.toContain("x".repeat(801));
    expect(result).toContain("…");
  },
);

it("keeps timeout ahead of an output-limit flag", () => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: null,
      termination: "timeout",
      outputLimitExceeded: true,
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toBe("setup failed (timed out after 3 seconds)");
});
