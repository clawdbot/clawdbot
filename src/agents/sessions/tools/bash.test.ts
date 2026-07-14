import path from "node:path";
// Bash tool helper tests cover conversion from model-facing timeout seconds to
// timer-safe millisecond values.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { BashOperations } from "./bash-operations.js";
import { createBashTool, createLocalBashOperations, resolveBashTimeoutMs } from "./bash.js";

describe("bash tool timeout helpers", () => {
  it("converts positive timeout seconds to timer-safe milliseconds", () => {
    expect(resolveBashTimeoutMs(1)).toBe(1_000);
    expect(resolveBashTimeoutMs(1.5)).toBe(1_500);
    expect(resolveBashTimeoutMs(0.0005)).toBe(1);
  });

  it("caps oversized timeout seconds", () => {
    // Node timers cannot safely represent arbitrary user-provided seconds.
    expect(resolveBashTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores absent, invalid, and non-positive timeout seconds", () => {
    expect(resolveBashTimeoutMs(undefined)).toBeUndefined();
    expect(resolveBashTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveBashTimeoutMs(0)).toBeUndefined();
    expect(resolveBashTimeoutMs(-1)).toBeUndefined();
  });
});

describe("bash tool output lifecycle", () => {
  it.runIf(process.platform !== "win32")("surfaces a configured shell launch error", async () => {
    const operations = createLocalBashOperations({
      shellPath: path.join(process.cwd(), "package.json"),
    });

    await expect(operations.exec("echo ok", process.cwd(), { onData: () => {} })).rejects.toThrow(
      /EACCES|permission denied/i,
    );
  });

  it("ignores output callbacks after execution settles", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("before\n"));
        setTimeout(() => onData(Buffer.from("late\n")), 0);
        return { exitCode: 0 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });

    const result = await tool.execute("call-late-output", { command: "ignored" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(result.content[0]).toEqual({ type: "text", text: "before\n" });
  });
});
