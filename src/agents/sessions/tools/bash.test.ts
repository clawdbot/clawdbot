import path from "node:path";
// Bash tool helper tests cover conversion from model-facing timeout seconds to
// timer-safe millisecond values.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { buildShellCommandInvocation } from "../../shell-utils.js";
import type { BashOperations } from "./bash-operations.js";
import { createBashTool, createLocalBashOperations } from "./bash.js";
import { resolveBashTimeoutMs } from "./bash.test-support.js";

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

  it("allows an absent timeout", () => {
    expect(resolveBashTimeoutMs(undefined)).toBeUndefined();
  });

  it.each([Number.NaN, 0, -1])("rejects invalid timeout %s", (timeout) => {
    expect(() => resolveBashTimeoutMs(timeout)).toThrow(
      "Invalid timeout: must be a positive finite number of seconds",
    );
  });

  it.each([Number.NaN, 0, -1])("rejects invalid timeout %s before execution", async (timeout) => {
    const exec = vi.fn<BashOperations["exec"]>();
    const tool = createBashTool(process.cwd(), { operations: { exec } });

    await expect(
      tool.execute("call-invalid-timeout", { command: "echo ok", timeout }),
    ).rejects.toThrow("Invalid timeout: must be a positive finite number of seconds");
    expect(exec).not.toHaveBeenCalled();
  });

  it("omits the command argv and supplies stdin for legacy WSL bash", () => {
    expect(
      buildShellCommandInvocation("printf ready", {
        shell: "C:\\Windows\\System32\\bash.exe",
        args: ["-s"],
        commandTransport: "stdin",
      }),
    ).toEqual({
      argv: ["C:\\Windows\\System32\\bash.exe", "-s"],
      input: "printf ready",
      stdin: "pipe",
    });
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

  it.runIf(process.platform !== "win32")(
    "tags stdout and stderr from the local shell backend",
    async () => {
      const operations = createLocalBashOperations();
      const chunks: Array<{ data: Buffer; stream?: "stdout" | "stderr" }> = [];

      const result = await operations.exec("printf stdout; printf stderr >&2", process.cwd(), {
        onData: (data, stream) => chunks.push({ data, stream }),
      });

      expect(result.exitCode).toBe(0);
      expect(
        Buffer.concat(
          chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.data),
        ).toString("utf8"),
      ).toBe("stdout");
      expect(
        Buffer.concat(
          chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.data),
        ).toString("utf8"),
      ).toBe("stderr");
      expect(chunks.every((chunk) => chunk.stream !== undefined)).toBe(true);
    },
  );

  it("decodes a split multi-byte character when the other stream interleaves", async () => {
    // stdout and stderr are independent pipes: each needs its own decoder, or a
    // character straddling a stdout read boundary is corrupted by an stderr write
    // landing between its bytes.
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from([0xe6, 0x97]), "stdout"); // leading bytes of 日
        onData(Buffer.from("E"), "stderr"); // interleaves mid-character
        onData(Buffer.from([0xa5, 0x0a]), "stdout");
        return { exitCode: 0 };
      },
    };
    const tool = createBashTool(process.cwd(), { operations });

    const result = await tool.execute("call-split-utf8", { command: "ignored" });

    expect(result.content[0]).toEqual({ type: "text", text: "E日\n" });
  });
});
