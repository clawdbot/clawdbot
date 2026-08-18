import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Voice Call tests cover cli plugin behavior.
import { Command } from "commander";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());
const findCallMatchesInStoreMock = vi.hoisted(() => vi.fn());
const loadActiveCallsFromStoreMock = vi.hoisted(() => vi.fn());
const tailscaleMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  getSelfInfo: vi.fn(),
  setup: vi.fn(),
}));
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
vi.mock("./manager/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manager/store.js")>()),
  findCallMatchesInStore: findCallMatchesInStoreMock,
  loadActiveCallsFromStore: loadActiveCallsFromStoreMock,
}));
vi.mock("./webhook/tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webhook/tailscale.js")>()),
  cleanupTailscaleExposureRoute: tailscaleMocks.cleanup,
  getTailscaleSelfInfo: tailscaleMocks.getSelfInfo,
  setupTailscaleExposureRoutes: tailscaleMocks.setup,
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

function gatewayTransportError(code?: number): Error {
  return Object.assign(new Error("gateway transport failed"), {
    name: "GatewayTransportError",
    kind: "closed",
    connectionDetails: { url: "ws://127.0.0.1:18789" },
    ...(code === undefined ? {} : { code }),
  });
}

function gatewayRequestError(message: string, gatewayCode = "UNAVAILABLE"): Error {
  return Object.assign(new Error(message), {
    name: "GatewayClientRequestError",
    gatewayCode,
    retryable: false,
  });
}

function gatewayCredentialsError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "GatewayCredentialsRequiredError",
    method: "voicecall.status",
    configPath: "/tmp/openclaw.json",
  });
}

describe("voice-call CLI status fallback", () => {
  afterEach(() => {
    callGatewayFromCliMock.mockReset();
    findCallMatchesInStoreMock.mockReset();
    loadActiveCallsFromStoreMock.mockReset();
    tailscaleMocks.cleanup.mockReset();
    tailscaleMocks.getSelfInfo.mockReset();
    tailscaleMocks.setup.mockReset();
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
    ensureRuntime = async () => ({ manager }) as never,
  ): Command {
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: config as never,
      ensureRuntime,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    return program;
  }

  async function runStatusWithUnavailableGateway(params: {
    persisted?: unknown;
    error?: Error;
    args?: string[];
  }): Promise<unknown> {
    callGatewayFromCliMock.mockRejectedValue(params.error ?? gatewayTransportError());
    findCallMatchesInStoreMock.mockResolvedValue({ byCallId: params.persisted });
    const ensureRuntime = vi.fn(async () => {
      throw new Error("status fallback must not initialize the telephony runtime");
    });
    const program = new Command();
    registerVoiceCallCli({
      program,
      config: {} as never,
      ensureRuntime,
      stateRuntime: {} as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    });
    const capturer = captureStdout();
    try {
      await program.parseAsync(
        ["voicecall", "status", ...(params.args ?? ["--call-id", "call-1"]), "--json"],
        { from: "user" },
      );
    } finally {
      capturer.restore();
    }
    expect(ensureRuntime).not.toHaveBeenCalled();
    return JSON.parse(capturer.output().trim());
  }

  it("uses the manager's persisted fallback when the gateway is unavailable", async () => {
    const result = await runStatusWithUnavailableGateway({
      persisted: {
        callId: "call-1",
        providerCallId: "CA123",
        state: "completed",
        endReason: "completed",
        endedAt: 1,
      },
    });
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("reports found:false when the call is neither active nor persisted", async () => {
    const result = await runStatusWithUnavailableGateway({});
    expect(result).toEqual({ found: false });
  });

  it("lists persisted active calls without initializing the telephony runtime", async () => {
    loadActiveCallsFromStoreMock.mockReturnValue({
      activeCalls: new Map([["call-1", { callId: "call-1", state: "ringing" }]]),
    });
    expect(await runStatusWithUnavailableGateway({ args: [] })).toEqual({
      found: true,
      calls: [{ callId: "call-1", state: "ringing" }],
    });
  });

  it("falls back after an abnormal local gateway close", async () => {
    const result = await runStatusWithUnavailableGateway({
      persisted: { callId: "call-1", state: "completed" },
      error: gatewayTransportError(1006),
    });
    expect(result).toMatchObject({ callId: "call-1", state: "completed" });
  });

  it("keeps reachable gateway request failures out of the standalone runtime", async () => {
    callGatewayFromCliMock.mockRejectedValue(
      gatewayRequestError("Voice call runtime generation is retired; use the current registration"),
    );
    const ensureRuntime = vi.fn();
    const program = buildProgram({}, {}, ensureRuntime);

    await expect(
      program.parseAsync(["voicecall", "call", "--message", "hello"], { from: "user" }),
    ).rejects.toThrow(
      "Gateway responded but voicecall failed: Voice call runtime generation is retired; use the current registration",
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("explains a standalone webhook port collision", async () => {
    callGatewayFromCliMock.mockRejectedValue(gatewayTransportError());
    const ensureRuntime = vi.fn(async () => {
      throw Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
    });
    const program = buildProgram({}, { serve: { port: 3334 } }, ensureRuntime);

    await expect(
      program.parseAsync(["voicecall", "call", "--message", "hello"], { from: "user" }),
    ).rejects.toThrow(
      "Voice-call webhook port 3334 is already in use. A running Gateway probably already serves it",
    );
  });

  it("keeps gateway credential failures out of the standalone runtime", async () => {
    callGatewayFromCliMock.mockRejectedValue(
      gatewayCredentialsError("gateway voicecall.status requires credentials"),
    );
    const ensureRuntime = vi.fn();
    const program = buildProgram({}, {}, ensureRuntime);

    await expect(
      program.parseAsync(["voicecall", "status", "--json"], { from: "user" }),
    ).rejects.toThrow(
      "Gateway requires credentials: gateway voicecall.status requires credentials",
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(loadActiveCallsFromStoreMock).not.toHaveBeenCalled();
  });

  it("redacts credential-bearing gateway URLs from operational errors", async () => {
    callGatewayFromCliMock.mockRejectedValue(
      Object.assign(
        new Error(
          "gateway closed (1008): policy wss://operator:hunter2secret@gw.example.ts.net:18789",
        ),
        {
          name: "GatewayTransportError",
          kind: "closed",
          code: 1008,
          connectionDetails: {
            url: "wss://operator:hunter2secret@gw.example.ts.net:18789?token=tok123",
          },
        },
      ),
    );
    const ensureRuntime = vi.fn();
    const program = buildProgram({}, {}, ensureRuntime);

    let thrown: unknown;
    await program
      .parseAsync(["voicecall", "status", "--json"], { from: "user" })
      .catch((err: unknown) => {
        thrown = err;
      });

    const text = thrown instanceof Error ? thrown.message : String(thrown);
    expect(text).toContain("Gateway connection at wss://***:***@gw.example.ts.net:18789");
    expect(text).not.toContain("hunter2secret");
    expect(text).not.toContain("tok123");
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("rejects non-decimal tail options through the registered command", async () => {
    const program = buildProgram({});
    await expect(
      program.parseAsync(["voicecall", "tail", "--since", "0x10"], { from: "user" }),
    ).rejects.toThrow("Invalid numeric value for --since: 0x10");
  });

  it("exposes the webhook target and enabled stream paths", async () => {
    tailscaleMocks.setup.mockResolvedValue("https://bot.example.ts.net/voice/webhook");
    const program = buildProgram(
      {},
      {
        serve: { port: 3334, path: "/voice/webhook" },
        tailscale: { mode: "off", port: 443, path: "/voice/webhook" },
        realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
        streaming: { enabled: true, streamPath: "/voice/stream" },
      },
    );
    const capturer = captureStdout();
    try {
      await program.parseAsync(
        [
          "voicecall",
          "expose",
          "--mode",
          "funnel",
          "--port",
          "4444",
          "--path",
          "/edge/custom/webhook",
          "--serve-path",
          "/custom/webhook",
        ],
        { from: "user" },
      );
    } finally {
      capturer.restore();
    }

    expect(tailscaleMocks.setup).toHaveBeenCalledWith({
      mode: "funnel",
      port: 443,
      routes: [
        {
          path: "/edge/custom/webhook",
          localUrl: "http://127.0.0.1:4444/custom/webhook",
        },
        {
          path: "/edge/voice/stream/realtime",
          localUrl: "http://127.0.0.1:4444/voice/stream/realtime",
        },
        {
          path: "/voice/stream",
          localUrl: "http://127.0.0.1:4444/voice/stream",
        },
      ],
    });
    expect(JSON.parse(capturer.output())).toMatchObject({
      localUrl: "http://127.0.0.1:4444/custom/webhook",
      streamPaths: ["/edge/voice/stream/realtime", "/voice/stream"],
    });
  });

  it("reports failure when any exposure route cannot be mounted", async () => {
    tailscaleMocks.setup.mockResolvedValue(null);
    tailscaleMocks.getSelfInfo.mockResolvedValue(null);
    const program = buildProgram(
      {},
      {
        serve: { port: 3334, path: "/voice/webhook" },
        tailscale: { mode: "off", port: 443, path: "/voice/webhook" },
        realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
        streaming: { enabled: false },
      },
    );
    const capturer = captureStdout();
    try {
      await program.parseAsync(["voicecall", "expose", "--mode", "funnel"], { from: "user" });
    } finally {
      capturer.restore();
    }

    expect(JSON.parse(capturer.output())).toMatchObject({
      ok: false,
      publicUrl: null,
    });
  });

  it("clears webhook and stream paths for both Tailscale modes", async () => {
    const program = buildProgram(
      {},
      {
        serve: { port: 3334, path: "/voice/webhook" },
        tailscale: { mode: "off", port: 443, path: "/voice/webhook" },
        realtime: { enabled: true, streamPath: "/voice/stream/realtime" },
        streaming: { enabled: true, streamPath: "/voice/stream" },
      },
    );
    const capturer = captureStdout();
    try {
      await program.parseAsync(["voicecall", "expose", "--mode", "off"], { from: "user" });
    } finally {
      capturer.restore();
    }

    expect(tailscaleMocks.cleanup.mock.calls).toEqual(
      ["/voice/webhook", "/voice/stream/realtime", "/voice/stream"].flatMap((exposurePath) => [
        [{ mode: "serve", port: 443, path: exposurePath }],
        [{ mode: "funnel", port: 443, path: exposurePath }],
      ]),
    );
    expect(JSON.parse(capturer.output())).toMatchObject({
      mode: "off",
      streamPaths: ["/voice/stream/realtime", "/voice/stream"],
    });
  });

  async function runCustomLogTailShortRead(
    appended: string | Buffer,
    firstReadBytes?: number,
    initial: string | Buffer = "initial\n",
    copyTruncated?: string | Buffer,
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
      .mockImplementationOnce(async () => {
        if (copyTruncated !== undefined) {
          fs.writeFileSync(logFile, copyTruncated);
        }
      })
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

  it("resets short-read text and UTF-8 state when a custom log is copy-truncated", async () => {
    const initial = "initial\n";
    const appended = '{"event":"staleé-with-more-observed-bytes"}\n';
    const replacement = '{"event":"fresh-start-full"}\n';
    const firstReadBytes = Buffer.byteLength('{"event":"stale', "utf8") + 1;
    const shortReadCursor = Buffer.byteLength(initial, "utf8") + firstReadBytes;

    expect(Buffer.byteLength(replacement, "utf8")).toBeGreaterThan(shortReadCursor);
    expect(Buffer.byteLength(replacement, "utf8")).toBeLessThan(
      Buffer.byteLength(initial, "utf8") + Buffer.byteLength(appended, "utf8"),
    );

    const result = await runCustomLogTailShortRead(appended, firstReadBytes, initial, replacement);

    expect(result.shortened).toBe(true);
    expect(result.output).toBe(replacement);
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
      .mockRejectedValueOnce(gatewayRequestError("unknown method: voicecall.continue.start"))
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
