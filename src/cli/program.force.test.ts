// Program force tests cover root force flag behavior and command propagation.
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileSyncMock = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

const execFileSyncMock = vi.hoisted(() => vi.fn<ExecFileSyncMock>());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

const probePortUsageMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/ports-probe.js", () => ({
  probePortUsage: (...args: unknown[]) => probePortUsageMock(...args),
}));

import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { forceFreePort, forceFreePortAndWait } from "./ports.js";

type PortProcess = ReturnType<typeof forceFreePort>[number];

describe("gateway --force helpers", () => {
  let originalKill: typeof process.kill;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
    originalPlatform = process.platform;
    probePortUsageMock.mockReset();
    probePortUsageMock.mockResolvedValue("busy");
    // Pin to linux so all lsof tests are platform-invariant.
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });

  afterEach(() => {
    process.kill = originalKill;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("parses lsof output into pid/command pairs", () => {
    const sample = ["p123", "cnode", "p456", "cpython", ""].join("\n");
    execFileSyncMock.mockReturnValue(sample);
    process.kill = vi.fn();

    const parsed = forceFreePort(18789);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("lsof"),
      ["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-FpFc"],
      { env: expect.any(Object), encoding: "utf-8", killSignal: "SIGKILL", timeout: 10_000 },
    );
    expect(parsed).toEqual<PortProcess[]>([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("rejects malformed lsof 'p' lines with no PID", () => {
    const sample = ["p", "cnode", "p456", "cpython", ""].join("\n");
    execFileSyncMock.mockReturnValue(sample);
    expect(() => forceFreePort(18789)).toThrow(/malformed PID field/);
  });

  it("rejects malformed lsof 'p' lines with digit-prefixed garbage", () => {
    const sample = ["p111abc", "cnode", "p456", "cpython", ""].join("\n");
    execFileSyncMock.mockReturnValue(sample);
    expect(() => forceFreePort(18789)).toThrow(/malformed PID field/);
  });

  it("does not return partial results when a later lsof PID is malformed", () => {
    const sample = ["p456", "cpython", "pabc", "cnode", ""].join("\n");
    execFileSyncMock.mockReturnValue(sample);
    expect(() => forceFreePort(18789)).toThrow(/malformed PID field/);
  });

  it("handles empty lsof output", () => {
    execFileSyncMock.mockReturnValue("");
    expect(forceFreePort(18789)).toEqual<PortProcess[]>([]);
  });

  it("rejects non-positive lsof PIDs", () => {
    const sample = ["p0", "cnode", "p456", "cpython", ""].join("\n");
    execFileSyncMock.mockReturnValue(sample);
    expect(() => forceFreePort(18789)).toThrow(/malformed PID field/);
  });

  it("returns empty list when lsof finds nothing", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("no matches") as NodeJS.ErrnoException & { status?: number };
      err.status = 1; // lsof uses exit 1 for no matches
      throw err;
    });
    expect(forceFreePort(18789)).toStrictEqual([]);
  });

  it("returns without cleanup when lsof and the bind probe find no listener", async () => {
    probePortUsageMock.mockResolvedValue("free");
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("no matches") as NodeJS.ErrnoException & { status?: number };
      err.status = 1;
      throw err;
    });

    const result = await forceFreePortAndWait(18789, { timeoutMs: 500, intervalMs: 100 });

    expect(result).toEqual({
      killed: [],
      waitedMs: 0,
      escalatedToSigkill: false,
    });
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(probePortUsageMock).toHaveBeenCalledWith(18789);
  });

  it("kills an interface-specific listener even when the bind probe would report free", async () => {
    probePortUsageMock.mockResolvedValue("free");
    execFileSyncMock.mockReturnValueOnce(["p42", "cnode", ""].join("\n")).mockReturnValue("");
    const killMock = vi.fn();
    process.kill = killMock;

    const result = await forceFreePortAndWait(18789, { timeoutMs: 500, intervalMs: 100 });

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(result).toEqual({
      killed: [{ pid: 42, command: "node" }],
      waitedMs: 0,
      escalatedToSigkill: false,
    });
    expect(probePortUsageMock).not.toHaveBeenCalled();
  });

  it("returns without fuser when lsof is unavailable and the bind probe reports free", async () => {
    probePortUsageMock.mockResolvedValue("free");
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await forceFreePortAndWait(18789, { timeoutMs: 500, intervalMs: 100 });

    expect(result).toEqual({
      killed: [],
      waitedMs: 0,
      escalatedToSigkill: false,
    });
    expect(execFileSyncMock).toHaveBeenCalledOnce();
    expect(probePortUsageMock).toHaveBeenCalledWith(18789);
  });

  it("fails closed when lsof has a malformed PID and fuser cannot identify one", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) {
        return ["p111abc", "cnode", ""].join("\n");
      }
      const err = new Error("no matches") as NodeJS.ErrnoException & {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      err.status = 1;
      err.stdout = "";
      err.stderr = "";
      throw err;
    });

    await expect(forceFreePortAndWait(18789, { timeoutMs: 200, intervalMs: 100 })).rejects.toThrow(
      /still busy.*no listener PID/i,
    );

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "fuser",
      ["-k", "-TERM", "18789/tcp"],
      expect.anything(),
    );
  });

  it("throws when lsof missing", () => {
    execFileSyncMock.mockImplementation(() => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => forceFreePort(18789)).toThrow(/lsof not found/);
  });

  it("kills each listener and returns metadata", () => {
    execFileSyncMock.mockReturnValue(["p42", "cnode", "p99", "cssh", ""].join("\n"));
    const killMock = vi.fn();
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
  });

  it("continues when a discovered listener exits before it can be signaled", () => {
    execFileSyncMock.mockReturnValue(["p42", "cnode", "p99", "cssh", ""].join("\n"));
    const gone = Object.assign(new Error("no such process"), { code: "ESRCH" });
    const killMock = vi.fn().mockImplementationOnce(() => {
      throw gone;
    });
    process.kill = killMock;

    expect(forceFreePort(18789)).toEqual<PortProcess[]>([
      { pid: 42, command: "node" },
      { pid: 99, command: "ssh" },
    ]);
    expect(killMock).toHaveBeenNthCalledWith(1, 42, "SIGTERM");
    expect(killMock).toHaveBeenNthCalledWith(2, 99, "SIGTERM");
  });

  it("does not suppress listener ownership-guard errors", () => {
    execFileSyncMock.mockReturnValue(["p42", "cnode", ""].join("\n"));
    const guardError = Object.assign(new Error("ownership verification failed"), {
      code: "ESRCH",
    });
    const killMock = vi.fn();
    process.kill = killMock;

    expect(() =>
      forceFreePort(18789, {
        beforeSignal: () => {
          throw guardError;
        },
      }),
    ).toThrow(guardError);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("preserves real signal permission failures", () => {
    execFileSyncMock.mockReturnValue(["p42", "cnode", ""].join("\n"));
    const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    process.kill = vi.fn(() => {
      throw denied;
    });

    expect(() => forceFreePort(18789)).toThrow(/failed to kill pid 42/);
  });

  it("retries until the port is free", async () => {
    vi.useFakeTimers();
    let call = 0;
    execFileSyncMock.mockImplementation(() => {
      call += 1;
      // 1st call: initial listeners to kill.
      // 2nd/3rd calls: still listed.
      // 4th call: gone.
      if (call === 1) {
        return ["p42", "cnode", ""].join("\n");
      }
      if (call === 2 || call === 3) {
        return ["p42", "cnode", ""].join("\n");
      }
      return "";
    });

    const killMock = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      sigtermTimeoutMs: 400,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(res.killed).toEqual<PortProcess[]>([{ pid: 42, command: "node" }]);
    expect(res.escalatedToSigkill).toBe(false);
    expect(res.waitedMs).toBe(100);

    vi.useRealTimers();
  });

  it("escalates to SIGKILL if SIGTERM doesn't free the port", async () => {
    vi.useFakeTimers();
    let call = 0;
    execFileSyncMock.mockImplementation(() => {
      call += 1;
      // 1st call: initial kill list; then keep showing until after SIGKILL.
      if (call <= 7) {
        return ["p42", "cnode", ""].join("\n");
      }
      return "";
    });

    const killMock = vi.fn();
    const beforeSignal = vi.fn();
    process.kill = killMock;

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 800,
      intervalMs: 100,
      sigtermTimeoutMs: 300,
      beforeSignal,
    });

    await vi.runAllTimersAsync();
    const res = await promise;

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(42, "SIGKILL");
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 42, signal: "SIGTERM" });
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 42, signal: "SIGKILL" });
    expect(res.escalatedToSigkill).toBe(true);

    vi.useRealTimers();
  });

  it("bounds oversized force-free intervals by the remaining timeout", async () => {
    execFileSyncMock.mockReturnValue(["p42", "cnode", ""].join("\n"));
    const killMock = vi.fn();
    process.kill = killMock;

    await expect(
      forceFreePortAndWait(18789, {
        timeoutMs: 2,
        intervalMs: Number.MAX_SAFE_INTEGER,
        sigtermTimeoutMs: 1,
      }),
    ).rejects.toThrow(/still has listeners/);

    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(42, "SIGKILL");
  });

  it("falls back to fuser when lsof is permission denied", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return "4242\n";
    });
    probePortUsageMock.mockResolvedValueOnce("busy").mockResolvedValue("free");

    const result = await forceFreePortAndWait(18789, { timeoutMs: 500, intervalMs: 100 });

    expect(result.escalatedToSigkill).toBe(false);
    expect(result.killed).toEqual<PortProcess[]>([{ pid: 4242 }]);
    const termCall = execFileSyncMock.mock.calls.find(
      ([cmd, args]) => cmd === "fuser" && Array.isArray(args) && args.includes("-TERM"),
    );
    expect(termCall?.[1]).toEqual(["-k", "-TERM", "18789/tcp"]);
    expect(termCall?.[2]).toEqual({
      env: expect.any(Object),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      killSignal: "SIGKILL",
      timeout: 10_000,
    });
  });

  it("freezes guarded fuser PIDs before signaling when the port owner changes", async () => {
    let fuserPids = [4242];
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (args.includes("-k")) {
        throw new Error("guarded fuser cleanup must not use resource-targeted kill");
      }
      return `${fuserPids.join(" ")}\n`;
    });
    probePortUsageMock.mockResolvedValueOnce("busy").mockResolvedValue("free");
    const killMock = vi.fn();
    process.kill = killMock;
    const beforeSignal = vi.fn(() => {
      fuserPids = [5252];
    });

    const result = await forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      beforeSignal,
    });

    expect(result.killed).toEqual<PortProcess[]>([{ pid: 4242 }]);
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 4242, signal: "SIGTERM" });
    expect(killMock).toHaveBeenCalledOnce();
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killMock).not.toHaveBeenCalledWith(5252, expect.anything());
    expect(execFileSyncMock).toHaveBeenCalledWith("fuser", ["18789/tcp"], expect.anything());
  });

  it("never derives guarded fuser victims from stderr diagnostics", async () => {
    execFileSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      const err = new Error("fuser diagnostics") as NodeJS.ErrnoException & {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      err.status = 1;
      err.stdout = "4242 5151oops\n";
      err.stderr = "18789/tcp: 5252\nfuser warning for device 6161\n";
      throw err;
    });
    probePortUsageMock.mockResolvedValueOnce("busy").mockResolvedValue("free");
    const killMock = vi.fn();
    process.kill = killMock;
    const beforeSignal = vi.fn();

    const result = await forceFreePortAndWait(18789, {
      timeoutMs: 500,
      intervalMs: 100,
      beforeSignal,
    });

    expect(result.killed).toEqual<PortProcess[]>([{ pid: 4242 }]);
    expect(beforeSignal).toHaveBeenCalledOnce();
    expect(beforeSignal).toHaveBeenCalledWith({ port: 18789, pid: 4242, signal: "SIGTERM" });
    expect(killMock).toHaveBeenCalledOnce();
    expect(killMock).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killMock).not.toHaveBeenCalledWith(5252, expect.anything());
    expect(killMock).not.toHaveBeenCalledWith(6161, expect.anything());
  });

  it("uses fuser SIGKILL escalation when port stays busy", async () => {
    vi.useFakeTimers();
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd.includes("lsof")) {
        const err = new Error("spawnSync lsof EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (args.includes("-TERM")) {
        return "1337\n";
      }
      if (args.includes("-KILL")) {
        return "1337\n";
      }
      return "";
    });

    probePortUsageMock
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValue("free");

    const promise = forceFreePortAndWait(18789, {
      timeoutMs: 300,
      intervalMs: 100,
      sigtermTimeoutMs: 100,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.escalatedToSigkill).toBe(true);
    expect(result.waitedMs).toBe(100);
    const killCall = execFileSyncMock.mock.calls.find(
      ([cmd, args]) => cmd === "fuser" && Array.isArray(args) && args.includes("-KILL"),
    );
    expect(killCall?.[1]).toEqual(["-k", "-KILL", "18789/tcp"]);
    expect((killCall?.[2] as { encoding?: string } | undefined)?.encoding).toBe("utf-8");
    vi.useRealTimers();
  });

  it("throws when lsof is unavailable and fuser is missing", async () => {
    // An inconclusive four-host probe must continue into the cleanup tools.
    probePortUsageMock.mockResolvedValue("unknown");
    execFileSyncMock.mockImplementation((cmd: string) => {
      const err = new Error(`spawnSync ${cmd} ENOENT`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    await expect(forceFreePortAndWait(18789, { timeoutMs: 200, intervalMs: 100 })).rejects.toThrow(
      /fuser not found/i,
    );
  });
});

describe("gateway --force helpers (Windows netstat path)", () => {
  let originalKill: typeof process.kill;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.clearAllMocks();
    originalKill = process.kill.bind(process);
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    process.kill = originalKill;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  const makeNetstatOutput = (port: number, ...pids: number[]) =>
    [
      "Proto  Local Address          Foreign Address        State           PID",
      ...pids.map(
        (pid) => `  TCP    0.0.0.0:${port}           0.0.0.0:0              LISTENING       ${pid}`,
      ),
    ].join("\r\n");

  const makeLocalizedNetstatOutput = () =>
    [
      "Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:18789        0.0.0.0:0              ABHOEREN        42",
      "  TCP    [::1]:18789          [::]:0                 ABHOEREN        99",
      "  TCP    127.0.0.1:18789      127.0.0.1:0            ABHOEREN        122",
      "  TCP    127.0.0.1:18789      127.0.0.1:50123        ESTABLISHED     123",
      "  TCP    127.0.0.1:18789      0.0.0.0:0                              124",
    ].join("\r\n");

  const forceFreeWindowsPort = (port: number): PortProcess[] => {
    process.kill = vi.fn();
    return forceFreePort(port);
  };

  it("returns empty list when netstat finds no listeners on the port", () => {
    execFileSyncMock.mockReturnValue(makeNetstatOutput(9999, 42));
    expect(forceFreeWindowsPort(18789)).toStrictEqual([]);
  });

  it("parses PIDs from netstat output correctly", () => {
    execFileSyncMock.mockReturnValue(makeNetstatOutput(18789, 42, 99));
    expect(forceFreeWindowsPort(18789)).toEqual<PortProcess[]>([{ pid: 42 }, { pid: 99 }]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      getWindowsSystem32ExePath("netstat.exe"),
      ["-ano"],
      {
        env: expect.any(Object),
        encoding: "utf-8",
        killSignal: "SIGKILL",
        timeout: 10_000,
      },
    );
  });

  it("parses localized Windows listener rows without depending on the state text", () => {
    execFileSyncMock.mockReturnValue(makeLocalizedNetstatOutput());
    expect(forceFreeWindowsPort(18789)).toEqual<PortProcess[]>([{ pid: 42 }, { pid: 99 }]);
  });

  it("does not incorrectly match a port that is a substring (e.g. 80 vs 8080)", () => {
    execFileSyncMock.mockReturnValue(makeNetstatOutput(8080, 42));
    expect(forceFreeWindowsPort(80)).toStrictEqual([]);
  });

  it("deduplicates PIDs that appear multiple times", () => {
    execFileSyncMock.mockReturnValue(makeNetstatOutput(18789, 42, 42));
    expect(forceFreeWindowsPort(18789)).toEqual<PortProcess[]>([{ pid: 42 }]);
  });

  it("throws a descriptive error when netstat fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("access denied");
    });
    expect(() => forceFreeWindowsPort(18789)).toThrow(/netstat failed/);
  });

  it("kills Windows listeners and returns metadata", () => {
    execFileSyncMock.mockReturnValue(makeNetstatOutput(18789, 42, 99));
    const killMock = vi.fn();
    process.kill = killMock;

    const killed = forceFreePort(18789);

    expect(killMock).toHaveBeenCalledTimes(2);
    expect(killMock).toHaveBeenCalledWith(42, "SIGTERM");
    expect(killMock).toHaveBeenCalledWith(99, "SIGTERM");
    expect(killed).toEqual<PortProcess[]>([{ pid: 42 }, { pid: 99 }]);
  });
});
