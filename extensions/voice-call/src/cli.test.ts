import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Voice Call tests cover cli plugin behavior.
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const sleepMock = vi.hoisted(() =>
  vi.fn(
    async (ms: number) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  ),
);

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  sleep: sleepMock,
}));

import { registerVoiceCallCli } from "./cli.js";

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

describe("voice-call CLI status fallback", () => {
  afterEach(() => {
    callGatewayFromCliMock.mockReset();
    sleepMock.mockReset();
    sleepMock.mockImplementation(
      async (ms: number) =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildProgram(
    manager: Record<string, unknown>,
    config: Record<string, unknown> = {},
  ): Command {
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: config as never,
      ensureRuntime: async () => ({ manager }) as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    return program;
  }

  async function runStatusWithUnavailableGateway(
    manager: Record<string, unknown>,
    error = new Error("connect ECONNREFUSED 127.0.0.1:18789"),
  ): Promise<unknown> {
    callGatewayFromCliMock.mockRejectedValue(error);
    const program = buildProgram(manager);
    const capturer = captureStdout();
    try {
      await program.parseAsync(["voicecall", "status", "--call-id", "call-1", "--json"], {
        from: "user",
      });
    } finally {
      capturer.restore();
    }
    return JSON.parse(capturer.output().trim());
  }

  it("uses the manager's persisted fallback when the gateway is unavailable", async () => {
    const result = await runStatusWithUnavailableGateway({
      getActiveCalls: () => [],
      getCallFromMemoryOrStore: async () => ({
        callId: "call-1",
        providerCallId: "CA123",
        state: "completed",
        endReason: "completed",
        endedAt: 1,
      }),
    });
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("reports found:false when the call is neither active nor persisted", async () => {
    const result = await runStatusWithUnavailableGateway({
      getActiveCalls: () => [],
      getCallFromMemoryOrStore: async () => undefined,
    });
    expect(result).toEqual({ found: false });
  });

  it("falls back after an abnormal local gateway close", async () => {
    const result = await runStatusWithUnavailableGateway(
      {
        getActiveCalls: () => [],
        getCallFromMemoryOrStore: async () => ({ callId: "call-1", state: "completed" }),
      },
      new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
    );
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("rejects non-decimal tail options through the registered command", async () => {
    const program = buildProgram({});
    await expect(
      program.parseAsync(["voicecall", "tail", "--since", "0x10"], { from: "user" }),
    ).rejects.toThrow("Invalid numeric value for --since: 0x10");
  });

  async function runCustomLogTailShortRead(
    appended: string | Buffer,
    firstReadBytes?: number,
    initial: string | Buffer = "initial\n",
  ): Promise<{ output: string; shortened: boolean }> {
    // openclaw-temp-dir: allow extension tests cannot import repo-only test helpers
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-tail-"));
    const logFile = path.join(tempDir, "custom.log");
    fs.writeFileSync(logFile, initial);
    const initialByteLength = Buffer.isBuffer(initial)
      ? initial.length
      : Buffer.byteLength(initial, "utf8");

    const sentinel = new Error("stop voice-call tail test");
    let output = "";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const originalReadSync = fs.readSync.bind(fs);
    const readSyncSpy = vi.spyOn(fs, "readSync");
    let shortened = false;

    readSyncSpy.mockImplementation(((fd, buffer, offset, length, position) => {
      if (
        !shortened &&
        firstReadBytes !== undefined &&
        typeof position === "number" &&
        position === initialByteLength &&
        Buffer.isBuffer(buffer)
      ) {
        shortened = true;
        return originalReadSync(fd, buffer, offset, firstReadBytes, position);
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);

    sleepMock
      .mockImplementationOnce(async () => {
        fs.appendFileSync(logFile, appended);
      })
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw sentinel;
      });

    try {
      const program = buildProgram({});
      await expect(
        program.parseAsync(
          ["voicecall", "tail", "--file", logFile, "--since", "0", "--poll", "50"],
          {
            from: "user",
          },
        ),
      ).rejects.toBe(sentinel);
    } finally {
      stdoutSpy.mockRestore();
      readSyncSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { output, shortened };
  }

  it("keeps custom log tail follow offset aligned with newline short reads", async () => {
    const result = await runCustomLogTailShortRead(
      "first\nsecond\n",
      Buffer.byteLength("first\n", "utf8"),
    );

    expect(result.shortened).toBe(true);
    expect(result.output).toContain("first\n");
    expect(result.output).toContain("second\n");
  });

  it("buffers custom log tail records across mid-record short reads", async () => {
    const result = await runCustomLogTailShortRead(
      '{"event":"first"}\n{"event":"second"}\n',
      Buffer.byteLength('{"event":"fir', "utf8"),
    );

    expect(result.shortened).toBe(true);
    expect(result.output).not.toContain('{"event":"fir\n');
    expect(result.output).toContain('{"event":"first"}\n');
    expect(result.output).toContain('{"event":"second"}\n');
  });

  it("buffers custom log tail UTF-8 characters across short reads", async () => {
    const result = await runCustomLogTailShortRead(
      '{"word":"café"}\n',
      Buffer.byteLength('{"word":"caf', "utf8") + 1,
    );

    expect(result.shortened).toBe(true);
    expect(result.output).not.toContain("\ufffd");
    expect(result.output).toContain('{"word":"café"}\n');
  });

  it("buffers custom log tail records that are partial at startup", async () => {
    const result = await runCustomLogTailShortRead('rt"}\n', undefined, '{"event":"sta');

    expect(result.shortened).toBe(false);
    expect(result.output).not.toContain('{"event":"sta\n');
    expect(result.output).toContain('{"event":"start"}\n');
  });

  it("buffers custom log tail UTF-8 characters that are partial at startup", async () => {
    const prefix = Buffer.from('{"word":"caf', "utf8");
    const eAcute = Buffer.from("é", "utf8");
    const initial = Buffer.concat([prefix, eAcute.subarray(0, 1)]);
    const suffix = Buffer.concat([eAcute.subarray(1), Buffer.from('"}\n', "utf8")]);
    const result = await runCustomLogTailShortRead(suffix, undefined, initial);

    expect(result.shortened).toBe(false);
    expect(result.output).not.toContain("\ufffd");
    expect(result.output).toContain('{"word":"café"}\n');
  });

  it("caps oversized operation timeouts through the start command", async () => {
    callGatewayFromCliMock.mockResolvedValue({ callId: "call-1" });
    const program = buildProgram({}, { ringTimeoutMs: Number.MAX_SAFE_INTEGER });
    await program.parseAsync(["voicecall", "start", "--to", "+15550001111"], {
      from: "user",
    });
    expect(callGatewayFromCliMock).toHaveBeenCalledWith(
      "voicecall.start",
      { json: true, timeout: String(MAX_TIMER_TIMEOUT_MS) },
      { to: "+15550001111", mode: "conversation" },
      { progress: false },
    );
  });

  it("caps oversized legacy continue timeouts through the command", async () => {
    callGatewayFromCliMock
      .mockRejectedValueOnce(new Error("unknown method: voicecall.continue.start"))
      .mockResolvedValueOnce({ success: true, transcript: "done" });
    const program = buildProgram({}, { transcriptTimeoutMs: Number.MAX_SAFE_INTEGER });
    await program.parseAsync(
      ["voicecall", "continue", "--call-id", "call-1", "--message", "hello"],
      { from: "user" },
    );
    expect(callGatewayFromCliMock).toHaveBeenLastCalledWith(
      "voicecall.continue",
      { json: true, timeout: String(MAX_TIMER_TIMEOUT_MS) },
      { callId: "call-1", message: "hello" },
      { progress: false },
    );
  });

  it("uses the configured continue deadline when the gateway poll timeout is non-finite", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
      pollTimeoutMs: Number.NaN,
    });
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(50_000);
    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    await expect(
      program.parseAsync(["voicecall", "continue", "--call-id", "call-1", "--message", "hello"], {
        from: "user",
      }),
    ).rejects.toThrow("voicecall continue timed out waiting for gateway operation");
    expect(callGatewayFromCliMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a withheld continue.result RPC to the overall poll deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    callGatewayFromCliMock
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "pending",
        pollTimeoutMs: 1_500,
      })
      .mockResolvedValueOnce({ status: "pending" })
      .mockImplementationOnce(
        async (_method: string, opts: { timeout: string }) =>
          await new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error(`gateway timeout after ${opts.timeout}ms`)),
              Number(opts.timeout),
            );
          }),
      );

    const program = buildProgram({}, { transcriptTimeoutMs: 100 });
    const startedAtMs = Date.now();
    const execution = program.parseAsync(
      ["voicecall", "continue", "--call-id", "call-1", "--message", "hello"],
      { from: "user" },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(callGatewayFromCliMock).toHaveBeenNthCalledWith(
      3,
      "voicecall.continue.result",
      { json: true, timeout: "500" },
      { operationId: "op-1" },
      { progress: false },
    );
    const rejected = expect(execution).rejects.toThrow("gateway timeout after 500ms");
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(Date.now() - startedAtMs).toBe(1_500);
  });
});
