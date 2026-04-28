import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const parseCmdScriptCommandLineMock = vi.hoisted(() => vi.fn());
const parseProcCmdlineMock = vi.hoisted(() => vi.fn());
const isGatewayArgvMock = vi.hoisted(() => vi.fn());
const findGatewayPidsOnPortSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(spawnSyncMock);
});

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    {
      readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
    },
    { mirrorToDefault: true },
  );
});

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

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
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
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
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

  it("formats pid lists as comma-separated output", () => {
    expect(formatGatewayPidList([1, 2, 3])).toBe("1, 2, 3");
  });
});
