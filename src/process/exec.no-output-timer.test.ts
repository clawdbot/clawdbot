// No-output timer tests cover idle command timeout and output reset behavior.
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "./exec.js";

describe("runCommandWithTimeout no-output timer", () => {
  it("resets no-output timeout while the child emits stdout", async () => {
    const script = [
      "let count = 0",
      "let timer",
      "const emit = () => {",
      "  process.stdout.write('.')",
      "  if (++count === 31) { clearInterval(timer); process.exit(0) }",
      "}",
      "emit()",
      "timer = setInterval(emit, 25)",
    ].join(";");
    const result = await runCommandWithTimeout([process.execPath, "-e", script], {
      timeoutMs: 10_000,
      // Leave ample process-startup margin while keeping total runtime above
      // this threshold, so only output-driven resets let the child finish.
      noOutputTimeoutMs: 500,
    });

    expect(result).toMatchObject({
      code: 0,
      noOutputTimedOut: false,
      stdout: ".".repeat(31),
      termination: "exit",
    });
  });

  it("bounds captured stdout and stderr while keeping the newest output", async () => {
    const script = ["process.stdout.write('abcdefgh')", "process.stderr.write('1234567')"].join(
      ";",
    );
    const result = await runCommandWithTimeout([process.execPath, "-e", script], {
      timeoutMs: 2_000,
      maxOutputBytes: 5,
    });

    expect(result.stdout).toBe("defgh");
    expect(result.stderr).toBe("34567");
    expect(result.stdoutTruncatedBytes).toBe(3);
    expect(result.stderrTruncatedBytes).toBe(2);
    expect(result.termination).toBe("exit");
  });

  it("marks no-output timeout when the child goes silent", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      {
        timeoutMs: 2_000,
        noOutputTimeoutMs: 100,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).toBe(124);
  });

  it("marks global timeout when the overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      { timeoutMs: 100 },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).toBe(124);
  });
});
