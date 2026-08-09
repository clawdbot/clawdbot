// Covers gateway process discovery across platform process listings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const parseCmdScriptCommandLineMock = vi.hoisted(() => vi.fn());
const parseProcCmdlineMock = vi.hoisted(() => vi.fn());
const isGatewayArgvMock = vi.hoisted(() => vi.fn());
const findGatewayPidsOnPortSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

vi.mock("../daemon/cmd-argv.js", () => ({
  parseCmdScriptCommandLine: (...args: unknown[]) => parseCmdScriptCommandLineMock(...args),
}));

vi.mock("./gateway-process-argv.js", () => ({
  parseProcCmdline: (...args: unknown[]) => parseProcCmdlineMock(...args),
  isGatewayArgv: (...args: unknown[]) => isGatewayArgvMock(...args),
}));

vi.mock("./restart-stale-pids.js", () => ({
  findGatewayPidsOnPortSync: (...args: unknown[]) => findGatewayPidsOnPortSyncMock(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
    isEnabled: vi.fn(() => false),
    subsystem: "test",
  })),
}));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: vi.fn(() => []),
  getChatChannelMeta: vi.fn(() => null),
}));

const {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  readGatewayProcessArgsSync,
  signalVerifiedGatewayPidSync,
} = await import("./gateway-processes.js");

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

describe("gateway-processes", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    readFileSyncMock.mockReset();
    parseCmdScriptCommandLineMock.mockReset();
    parseProcCmdlineMock.mockReset();
    isGatewayArgvMock.mockReset();
    findGatewayPidsOnPortSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads linux process args from /proc and parses cmdlines", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("node\0dist/index.js\0gateway\0run\0");
    parseProcCmdlineMock.mockReturnValue(["node", "dist/index.js", "gateway", "run"]);

    expect(readGatewayProcessArgsSync(4242)).toEqual(["node", "dist/index.js", "gateway", "run"]);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/4242/cmdline", "utf8");
    expect(parseProcCmdlineMock).toHaveBeenCalledWith("node\0dist/index.js\0gateway\0run\0");
  });

  it("reads darwin process args from ps output and returns null on ps failure", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "node /repo/dist/index.js gateway run\n",
      })
      .mockReturnValueOnce({
        error: null,
        status: 1,
        stdout: "",
      });

    expect(readGatewayProcessArgsSync(123)).toEqual([
      "node",
      "/repo/dist/index.js",
      "gateway",
      "run",
    ]);
    expect(readGatewayProcessArgsSync(124)).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-o", "command=", "-p", "123"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 1_000,
    });
  });

  it("falls back from powershell to wmic for windows process args", () => {
    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("powershell missing"),
        status: null,
        stdout: "",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "CommandLine=node.exe gateway run\r\n",
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);

    expect(readGatewayProcessArgsSync(77)).toEqual(["node.exe", "gateway", "run"]);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsWmicExePath());
    expect(parseCmdScriptCommandLineMock).toHaveBeenCalledWith("node.exe gateway run");
  });

  it("decodes UTF-16 WMIC output when reading windows process args", () => {
    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("powershell missing"),
        status: null,
        stdout: "",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: Buffer.from("\uFEFFCommandLine=node.exe gateway run\r\n", "utf16le"),
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);

    expect(readGatewayProcessArgsSync(77)).toEqual(["node.exe", "gateway", "run"]);
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsWmicExePath());
    expect(parseCmdScriptCommandLineMock).toHaveBeenCalledWith("node.exe gateway run");
  });

  it("signals only verified gateway processes", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("node\0gateway\0");
    parseProcCmdlineMock.mockReturnValue(["node", "gateway"]);
    isGatewayArgvMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    signalVerifiedGatewayPidSync(500, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");

    expect(() => signalVerifiedGatewayPidSync(501, "SIGUSR1")).toThrow(
      /refusing to signal non-gateway process pid 501/,
    );
  });

  it("swallows ESRCH when a verified gateway process exits before the signal", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("node\0gateway\0");
    parseProcCmdlineMock.mockReturnValue(["node", "gateway"]);
    isGatewayArgvMock.mockReturnValue(true);
    const esrchErr = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw esrchErr;
    });

    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM")).not.toThrow();
    expect(killSpy).toHaveBeenCalledWith(500, "SIGTERM");
  });

  it("re-throws non-ESRCH kill errors", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("node\0gateway\0");
    parseProcCmdlineMock.mockReturnValue(["node", "gateway"]);
    isGatewayArgvMock.mockReturnValue(true);
    const epermErr = Object.assign(new Error("permission denied"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });

    expect(() => signalVerifiedGatewayPidSync(500, "SIGTERM")).toThrow("permission denied");
  });

  it("dedupes and filters verified gateway listener pids on unix and windows", () => {
    setPlatform("linux");
    findGatewayPidsOnPortSyncMock.mockReturnValue([process.pid, 200, 200, 300, -1]);
    readFileSyncMock.mockReturnValueOnce("openclaw-gateway\0gateway\0");
    readFileSyncMock.mockReturnValueOnce("python\0-m\0http.server\0");
    parseProcCmdlineMock
      .mockReturnValueOnce(["openclaw-gateway", "gateway"])
      .mockReturnValueOnce(["python", "-m", "http.server"]);
    isGatewayArgvMock.mockReturnValueOnce(true).mockReturnValueOnce(false);

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "200\r\n200\r\n0\r\n",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "node.exe gateway run",
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);
    isGatewayArgvMock.mockReturnValue(true);

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
  });

  it("falls back from powershell to trusted netstat for windows listener pids", () => {
    setPlatform("win32");
    spawnSyncMock
      .mockReturnValueOnce({
        error: new Error("powershell missing"),
        status: null,
        stdout: "",
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: [
          "Proto  Local Address          Foreign Address        State           PID",
          "TCP    127.0.0.1:18789       127.0.0.1:0            ABHOEREN       998",
          "TCP    127.0.0.1:18789       127.0.0.1:54321        HERGESTELLT    999",
          "TCP    0.0.0.0:18789         0.0.0.0:0              ABHOEREN       200",
          "TCP    [::]:18789            [::]:0                 ABHOEREN       200",
        ].join("\r\n"),
      })
      .mockReturnValueOnce({
        error: null,
        status: 0,
        stdout: "node.exe gateway run",
      });
    parseCmdScriptCommandLineMock.mockReturnValue(["node.exe", "gateway", "run"]);
    isGatewayArgvMock.mockReturnValue(true);

    expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual([200]);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(getWindowsPowerShellExePath());
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe(getWindowsSystem32ExePath("netstat.exe"));
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual(["-ano"]);
    expect(spawnSyncMock.mock.calls[2]?.[0]).toBe(getWindowsPowerShellExePath());
  });

  it("formats pid lists as comma-separated output", () => {
    expect(formatGatewayPidList([1, 2, 3])).toBe("1, 2, 3");
  });
});
