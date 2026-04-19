import { afterEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp, registerLogsCli } from "./logs-cli.js";

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
  buildGatewayConnectionDetails: (
    ...args: Parameters<typeof import("../gateway/call.js").buildGatewayConnectionDetails>
  ) => buildGatewayConnectionDetails(...args),
}));

vi.mock("../logging/log-tail.js", () => ({
  readConfiguredLogTail: (
    ...args: Parameters<typeof import("../logging/log-tail.js").readConfiguredLogTail>
  ) => readConfiguredLogTail(...args),
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
    expect(timestamp).toBeTruthy();
    expect(timestamp?.endsWith("Z")).toBe(false);
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
    expect(stderrWrites.join("")).toContain("reading local log file instead");
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
