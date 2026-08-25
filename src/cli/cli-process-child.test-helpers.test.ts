import { describe, expect, it } from "vitest";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

describe("formatCliProcessFailure", () => {
  it("includes the failure identity and both captured output tails", () => {
    const reason =
      "CLI process did not exit before the 240000ms deadlock guard (SIGKILL sent; exitCode=null signalCode=null)";
    const message = formatCliProcessFailure({
      reason,
      stderr: "startup trace: entry.bootstrap",
      stdout: "partial command output",
    });

    expect(message).toContain(reason);
    expect(message).toContain("startup trace: entry.bootstrap");
    expect(message).toContain("partial command output");
  });

  it("keeps the end of streams longer than the output tail cap", () => {
    const message = formatCliProcessFailure({
      reason: "wrong exit code",
      stderr: "",
      stdout: `${"x".repeat(8_005)}END`,
    });

    expect(message).toContain("[... truncated 8 chars ...]");
    expect(message).toMatch(/xEND$/u);
  });
});

describe("runCliProcessChild", () => {
  it("reports the child's exit code and both streams", async () => {
    const result = await runCliProcessChild({
      nodeArgs: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
      ],
      env: process.env,
    });

    expect(result).toEqual({ code: 3, signal: null, stdout: "out", stderr: "err" });
  });

  it("names the deadlock guard and keeps partial output when a child never exits", async () => {
    await expect(
      runCliProcessChild({
        nodeArgs: ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1_000);"],
        env: process.env,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/500ms deadlock guard[\s\S]*partial/u);
  });
});
