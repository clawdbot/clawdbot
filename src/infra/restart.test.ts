// Covers gateway restart process and supervisor paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv, withEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: vi.fn(),
    __promisify__: vi.fn(),
  }),
);
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: execFileMock,
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    } as Partial<typeof import("node:child_process")>,
  );
});

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
  resolveStateDir: (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

const { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
  await import("./restart-stale-pids.js");
const { triggerOpenClawRestart } = await import("./restart.js");

const envSnapshot = captureFullEnv();

beforeEach(() => {
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset();
  resolveGatewayPortMock.mockReset();
  resolveLsofCommandSyncMock.mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReturnValue(18789);
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
});

afterEach(() => {
  envSnapshot.restore();
  vi.restoreAllMocks();
});

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

function requireFirstSpawnSyncCall(): [unknown, unknown, unknown] {
  const [call] = spawnSyncMock.mock.calls;
  if (!call) {
    throw new Error("expected spawnSync call");
  }
  return call as [unknown, unknown, unknown];
}

describe.runIf(process.platform !== "win32")("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-openclaw/current processes", () => {
    const gatewayPidA = process.pid + 1000;
    const gatewayPidB = process.pid + 2000;
    const foreignPid = process.pid + 3000;
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "copenclaw",
        `p${gatewayPidA}`,
        "copenclaw-gateway",
        `p${foreignPid}`,
        "cnode",
        `p${gatewayPidB}`,
        "cOpenClaw",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18789);

    expect(pids).toEqual([gatewayPidA, gatewayPidB]);
    const [command, args, options] =
      spawnSyncMock.mock.calls.find(
        ([spawnCommand, spawnArgs]) =>
          spawnCommand === "/usr/sbin/lsof" &&
          Array.isArray(spawnArgs) &&
          spawnArgs.includes("-iTCP:18789"),
      ) ?? [];
    expect(command).toBe("/usr/sbin/lsof");
    expect(args).toEqual(["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-Fpc"]);
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.encoding).toBe(
      "utf8",
    );
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.timeout).toBe(2000);
  });

  it("returns empty when lsof fails", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 1,
      stdout: "",
      stderr: "lsof failed",
    });

    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("cleanStaleGatewayProcessesSync", () => {
  it("kills stale gateway pids discovered on the gateway port", () => {
    const stalePidA = process.pid + 1000;
    const stalePidB = process.pid + 2000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePidA}`, "copenclaw", `p${stalePidB}`, "copenclaw-gateway"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toEqual([stalePidA, stalePidB]);
    expect(resolveGatewayPortMock).toHaveBeenCalledWith(undefined, process.env);
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePidA, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(stalePidB, "SIGKILL");
  });

  it("uses explicit port override when provided", () => {
    const stalePid = process.pid + 1000;
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePid}`, "copenclaw"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999);

    expect(killed).toEqual([stalePid]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    const lsofCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "/usr/sbin/lsof");
    expect(lsofCalls).toHaveLength(2);
    const [command, args, options] = requireFirstSpawnSyncCall();
    expect(command).toBe("/usr/sbin/lsof");
    expect(args).toEqual(["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"]);
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.encoding).toBe(
      "utf8",
    );
    expect((options as { encoding?: unknown; timeout?: unknown } | undefined)?.timeout).toBe(2000);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("returns empty when no stale listeners are found", () => {
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync();

    expect(killed).toStrictEqual([]);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe("triggerOpenClawRestart", () => {
  it("does not kickstart after bootstrap registers an unloaded LaunchAgent", () => {
    setPlatform("darwin");
    withEnv(
      { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      () => {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
          if (command === "/usr/sbin/lsof") {
            return { error: undefined, status: 1, stdout: "" };
          }
          if (command === "launchctl" && args[0] === "kickstart" && args[1] === "-k") {
            return { error: undefined, status: 113, stderr: "service not loaded" };
          }
          if (command === "launchctl" && args[0] === "bootstrap") {
            return { error: undefined, status: 0, stderr: "" };
          }
          return { error: undefined, status: 1, stdout: "" };
        });

        const result = triggerOpenClawRestart();

        expect(result).toEqual({
          ok: true,
          method: "launchctl",
          tried: [
            `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
            `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
          ],
        });
      },
    );
  });

  it("continues when launchctl bootstrap reports the service is already loaded", () => {
    setPlatform("darwin");
    withEnv(
      { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      () => {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
          if (command === "/usr/sbin/lsof") {
            return { error: undefined, status: 1, stdout: "" };
          }
          if (command === "launchctl" && args[0] === "kickstart" && args[1] === "-k") {
            return { error: undefined, status: 113, stderr: "service not loaded" };
          }
          if (command === "launchctl" && args[0] === "bootstrap") {
            return { error: undefined, status: 37, stderr: "Operation already in progress" };
          }
          if (command === "launchctl" && args[0] === "kickstart") {
            return { error: undefined, status: 0, stdout: "" };
          }
          return { error: undefined, status: 1, stdout: "" };
        });

        const result = triggerOpenClawRestart();

        expect(result).toEqual({
          ok: true,
          method: "launchctl",
          tried: [
            `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
            `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
            `launchctl kickstart gui/${uid}/ai.openclaw.gateway`,
          ],
        });
      },
    );
  });
});
