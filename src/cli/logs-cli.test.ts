import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayTransportError } from "../gateway/call.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp, registerLogsCli } from "./logs-cli.js";

const { MockGatewayTransportError } = vi.hoisted(() => ({
  MockGatewayTransportError: class extends Error {
    readonly kind: string;
    readonly connectionDetails: unknown;
    readonly code?: number;
    readonly reason?: string;
    readonly timeoutMs?: number;

    constructor(params: {
      kind: string;
      message: string;
      connectionDetails: unknown;
      code?: number;
      reason?: string;
      timeoutMs?: number;
    }) {
      super(params.message);
      this.name = "GatewayTransportError";
      this.kind = params.kind;
      this.connectionDetails = params.connectionDetails;
      if (params.code !== undefined) {
        this.code = params.code;
      }
      if (params.reason !== undefined) {
        this.reason = params.reason;
      }
      if (params.timeoutMs !== undefined) {
        this.timeoutMs = params.timeoutMs;
      }
    }
  },
}));

const callGatewayFromCli = vi.fn();
const readConfiguredLogTail = vi.fn();
const buildGatewayConnectionDetails = vi.fn(
  (_options?: {
    configPath?: string;
    config?: unknown;
    url?: string;
    urlSource?: "cli" | "env";
  }) => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
);

vi.mock("../gateway/call.js", () => ({
  GatewayTransportError: MockGatewayTransportError,
  buildGatewayConnectionDetails: (
    ...args: Parameters<typeof import("../gateway/call.js").buildGatewayConnectionDetails>
  ) => buildGatewayConnectionDetails(...args),
  isGatewayTransportError: (value: unknown) => value instanceof MockGatewayTransportError,
}));

vi.mock("../logging/log-tail.js", () => ({
  readConfiguredLogTail: (
    ...args: Parameters<typeof import("../logging/log-tail.js").readConfiguredLogTail>
  ) => readConfiguredLogTail(...args),
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: vi.fn().mockReturnValue(0),
}));

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

async function runLogsCli(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli as (program: import("commander").Command) => void,
    argv,
  });
}

function captureStdoutWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

function captureStderrWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe("logs cli", () => {
  afterEach(() => {
    callGatewayFromCli.mockClear();
    readConfiguredLogTail.mockClear();
    buildGatewayConnectionDetails.mockClear();
    vi.restoreAllMocks();
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["raw line"],
      truncated: true,
      reset: true,
    });

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();

    await runLogsCli(["logs"]);

    expect(stdoutWrites.join("")).toContain("Log file:");
    expect(stdoutWrites.join("")).toContain("raw line");
    expect(stderrWrites.join("")).toContain("Log tail truncated");
    expect(stderrWrites.join("")).toContain("Log cursor reset");
  });

  it("wires --local-time through CLI parsing and emits local timestamps", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: [
        JSON.stringify({
          time: "2025-01-01T12:00:00.000Z",
          _meta: { logLevelName: "INFO", name: JSON.stringify({ subsystem: "gateway" }) },
          0: "line one",
        }),
      ],
    });

    const stdoutWrites = captureStdoutWrites();

    await runLogsCli(["logs", "--local-time", "--plain"]);

    const output = stdoutWrites.join("");
    expect(output).toContain("line one");
    const timestamp = output.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?/u)?.[0];
    if (timestamp === undefined) {
      throw new Error("expected local timestamp in logs output");
    }
    expect(timestamp.endsWith("Z")).toBe(false);
  });

  it("warns when the output pipe closes", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: ["line one"],
    });

    const stderrWrites = captureStderrWrites();
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const err = new Error("EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });

    await runLogsCli(["logs"]);

    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  it("falls back to the local log file on loopback pairing-required errors", async () => {
    callGatewayFromCli.mockRejectedValueOnce(new Error("gateway closed (1008): pairing required"));
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["local fallback line"],
      truncated: false,
      reset: false,
    });

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();

    await runLogsCli(["logs"]);

    expect(readConfiguredLogTail).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 200,
      maxBytes: 250_000,
    });
    expect(stdoutWrites.join("")).toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
  });

  it("falls back to the local log file on loopback scope-upgrade errors", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-123)"),
    );
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["local fallback line"],
      truncated: false,
      reset: false,
    });

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();

    await runLogsCli(["logs"]);

    expect(readConfiguredLogTail).toHaveBeenCalledTimes(1);
    expect(stdoutWrites.join("")).toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
  });

  it("falls back to the configured Gateway file log on loopback gateway close errors", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      new GatewayTransportError({
        kind: "closed",
        code: 1000,
        reason: "no close reason",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
        message: "gateway closed (1000 normal closure): no close reason",
      }),
    );
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["local fallback line"],
      truncated: false,
      reset: false,
    });

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();

    await runLogsCli(["logs"]);

    expect(readConfiguredLogTail).toHaveBeenCalledTimes(1);
    expect(stdoutWrites.join("")).toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
  });

  it("falls back to the configured Gateway file log on post-handshake plain close errors", async () => {
    callGatewayFromCli.mockRejectedValueOnce(new Error("gateway closed (1006): abnormal closure"));
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["local fallback line"],
      truncated: false,
      reset: false,
    });

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();

    await runLogsCli(["logs"]);

    expect(readConfiguredLogTail).toHaveBeenCalledTimes(1);
    expect(stdoutWrites.join("")).toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
  });

  describe("--follow retry behavior", () => {
    it("uses local fallback (not retry warning) for loopback close errors in --follow mode", async () => {
      // Loopback close errors are absorbed by shouldUseLocalLogsFallback inside fetchLogs —
      // they never reach the retry path, so no "gateway disconnected" warning is emitted.
      callGatewayFromCli.mockRejectedValueOnce(
        new GatewayTransportError({
          kind: "closed",
          code: 1006,
          reason: "abnormal closure",
          connectionDetails: {
            url: "ws://127.0.0.1:18789",
            urlSource: "local loopback",
            message: "",
          },
          message: "gateway closed (1006 abnormal closure): abnormal closure",
        }),
      );
      readConfiguredLogTail.mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        cursor: 5,
        lines: ["local fallback line"],
        truncated: false,
        reset: false,
      });

      const stderrWrites = captureStderrWrites();
      const stdoutWrites = captureStdoutWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--interval", "1"]);

      expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
      expect(stderrWrites.join("")).not.toContain("gateway disconnected");
      expect(stdoutWrites.join("")).toContain("local fallback line");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits after exhausting max retries in --follow mode with explicit URL", async () => {
      // Explicit --url bypasses shouldUseLocalLogsFallback so close errors reach the retry path.
      // initial attempt + 8 retries = 9 total calls before fatal exit.
      const closeError = new GatewayTransportError({
        kind: "closed",
        code: 1006,
        reason: "abnormal closure",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "cli",
          message: "",
        },
        message: "gateway closed (1006 abnormal closure): abnormal closure",
      });
      for (let i = 0; i <= 8; i += 1) {
        callGatewayFromCli.mockRejectedValueOnce(closeError);
      }

      const stderrWrites = captureStderrWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--url", "ws://127.0.0.1:18789"]);

      expect((stderrWrites.join("").match(/gateway disconnected/g) ?? []).length).toBe(8);
      expect(stderrWrites.join("")).toContain("Gateway not reachable");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("retries on transient close errors in --follow mode with explicit URL (no local fallback)", async () => {
      callGatewayFromCli
        .mockRejectedValueOnce(
          new GatewayTransportError({
            kind: "closed",
            code: 1006,
            reason: "abnormal closure",
            connectionDetails: {
              url: "ws://remote.example.com:18789",
              urlSource: "cli",
              message: "",
            },
            message: "gateway closed (1006 abnormal closure): abnormal closure",
          }),
        )
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 10,
          lines: ["line from remote"],
        });

      const stderrWrites = captureStderrWrites();
      const stdoutWrites = captureStdoutWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli([
        "logs",
        "--follow",
        "--interval",
        "1",
        "--url",
        "ws://remote.example.com:18789",
      ]);

      expect(readConfiguredLogTail).not.toHaveBeenCalled();
      expect(stderrWrites.join("")).toContain("gateway disconnected");
      expect(stderrWrites.join("")).toContain("gateway reconnected");
      expect(stdoutWrites.join("")).toContain("line from remote");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("emits notice JSON records for retry and reconnect in --follow --json mode", async () => {
      callGatewayFromCli
        .mockRejectedValueOnce(
          new GatewayTransportError({
            kind: "closed",
            code: 1006,
            reason: "abnormal closure",
            connectionDetails: {
              url: "ws://remote.example.com:18789",
              urlSource: "cli",
              message: "",
            },
            message: "gateway closed (1006 abnormal closure): abnormal closure",
          }),
        )
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 10,
          lines: [],
        });

      const stderrWrites = captureStderrWrites();
      const stdoutWrites = captureStdoutWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli([
        "logs",
        "--follow",
        "--interval",
        "1",
        "--json",
        "--url",
        "ws://remote.example.com:18789",
      ]);

      const stderr = stderrWrites.join("");
      const noticeRecords = stderr
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(noticeRecords.filter((record) => record.type === "notice")).toEqual([
        {
          type: "notice",
          message: "[logs] gateway disconnected, reconnecting in 0s...",
        },
        { type: "notice", message: "[logs] gateway reconnected" },
      ]);
      expect(stdoutWrites.join("")).toContain('"type":"meta"');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits immediately on pairing-required close errors in --follow mode with explicit URL", async () => {
      callGatewayFromCli.mockRejectedValueOnce(
        new GatewayTransportError({
          kind: "closed",
          code: 1008,
          reason: "pairing required",
          connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "cli", message: "" },
          message: "gateway closed (1008 policy violation): pairing required",
        }),
      );

      const stderrWrites = captureStderrWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--url", "ws://127.0.0.1:18789"]);

      expect(stderrWrites.join("")).not.toContain("gateway disconnected");
      expect(stderrWrites.join("")).toContain("Gateway not reachable");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits immediately on app-defined auth errors (4xxx) in --follow mode with explicit URL", async () => {
      callGatewayFromCli.mockRejectedValueOnce(
        new GatewayTransportError({
          kind: "closed",
          code: 4001,
          reason: "unauthorized",
          connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "cli", message: "" },
          message: "gateway closed (4001 unauthorized): unauthorized",
        }),
      );

      const stderrWrites = captureStderrWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--url", "ws://127.0.0.1:18789"]);

      expect(stderrWrites.join("")).not.toContain("gateway disconnected");
      expect(stderrWrites.join("")).toContain("Gateway not reachable");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it("does not use local fallback for explicit Gateway URLs", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      new GatewayTransportError({
        kind: "closed",
        code: 1000,
        reason: "no close reason",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "",
        },
        message: "gateway closed (1000 normal closure): no close reason",
      }),
    );

    const stdoutWrites = captureStdoutWrites();
    const stderrWrites = captureStderrWrites();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runLogsCli(["logs", "--url", "ws://127.0.0.1:18789"]);

    expect(readConfiguredLogTail).not.toHaveBeenCalled();
    expect(stdoutWrites.join("")).not.toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Gateway not reachable");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe("formatLogTimestamp", () => {
    it("formats UTC timestamp in plain mode by default", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z");
      expect(result).toBe("2025-01-01T12:00:00.000Z");
    });

    it("formats UTC timestamp in pretty mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z", "pretty");
      expect(result).toBe("12:00:00+00:00");
    });

    it("formats local time in plain mode when localTime is true", () => {
      const utcTime = "2025-01-01T12:00:00.000Z";
      const result = formatLogTimestamp(utcTime, "plain", true);
      // Should be local time with explicit timezone offset (not 'Z' suffix).
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      // The exact time depends on timezone, but should be different from UTC
      expect(result).not.toBe(utcTime);
    });

    it("formats local time in pretty mode when localTime is true", () => {
      const utcTime = "2025-01-01T12:00:00.000Z";
      const result = formatLogTimestamp(utcTime, "pretty", true);
      // Should be HH:MM:SS±HH:MM format with timezone offset.
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it.each([
      { input: undefined, expected: "" },
      { input: "", expected: "" },
      { input: "invalid-date", expected: "invalid-date" },
      { input: "not-a-date", expected: "not-a-date" },
    ])("preserves timestamp fallback for $input", ({ input, expected }) => {
      expect(formatLogTimestamp(input)).toBe(expected);
    });
  });
});
