// Covers stale gateway process detection and cleanup.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// This file primarily tests lsof-based Unix port polling. On Windows,
// findGatewayPidsOnPortSync delegates to findVerifiedGatewayListenerPidsOnPortSync
// (PowerShell/netstat discovery in gateway-processes.ts) instead of returning [].
// Running lsof-dependent tests on a Windows CI runner is not possible, so the suite
// is skipped on Windows; cross-platform tests mock process.platform to win32.
const isWindows = process.platform === "win32";

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockResolveGatewayPort = vi.hoisted(() => vi.fn(() => 18789));
const mockRestartWarn = vi.hoisted(() => vi.fn());
const mockReadWindowsListeningPids = vi.hoisted(() =>
  vi.fn((_port: number, _timeoutMs?: number): number[] => []),
);
const mockReadWindowsListeningPidsResult = vi.hoisted(() =>
  vi.fn<(_port: number, _timeoutMs?: number) => MockWindowsListeningPidsResult>(
    (_port: number, _timeoutMs?: number) => ({ ok: true, pids: [] }),
  ),
);
const mockReadWindowsProcessArgs = vi.hoisted(() =>
  vi.fn((_pid: number, _timeoutMs?: number): string[] | null => null),
);
const mockReadWindowsProcessArgsResult = vi.hoisted(() =>
  vi.fn<(_pid: number, _timeoutMs?: number) => MockWindowsProcessArgsResult>(
    (_pid: number, _timeoutMs?: number) => ({ ok: true, args: null }),
  ),
);
// Drives the Linux `/proc/<pid>/status` ancestor walk inside
// `getSelfAndAncestorPidsSync`. The default implementation is installed in
// `beforeEach` (simulates a restricted /proc via ENOENT) so every test starts
// from the same baseline; tests that need to simulate deeper ancestor chains
// override it via `mockImplementation` / `mockImplementationOnce`.
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      // `readFileSync` is an overloaded function; a single arrow expression
      // cannot match every overload (no-encoding → NonSharedBuffer, encoded →
      // string, etc.), which tsgo flags as TS2322. Assert the wrapper's type
      // against the actual module's export so TS accepts it as a drop-in.
      // The test only exercises the string-returning overload (encoded /proc
      // reads); the cast is a precise retype, not `any`.
      readFileSync: ((path: unknown, encoding?: unknown) =>
        mockReadFileSync(path, encoding)) as typeof actual.readFileSync,
    }),
  );
});

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
      execFileSync: vi.fn(),
    },
  );
});

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: () => mockResolveGatewayPort(),
}));

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: vi.fn(() => "lsof"),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: (...args: unknown[]) => mockRestartWarn(...args),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("./gateway-processes.js", () => ({}));

vi.mock("./windows-port-pids.js", () => ({
  readWindowsListeningPidsOnPortSync: (port: number, timeoutMs?: number) =>
    mockReadWindowsListeningPids(port, timeoutMs),
  readWindowsListeningPidsResultSync: (port: number, timeoutMs?: number) =>
    mockReadWindowsListeningPidsResult(port, timeoutMs),
  readWindowsProcessArgsSync: (pid: number, timeoutMs?: number) =>
    mockReadWindowsProcessArgs(pid, timeoutMs),
  readWindowsProcessArgsResultSync: (pid: number, timeoutMs?: number) =>
    mockReadWindowsProcessArgsResult(pid, timeoutMs),
}));

vi.mock("./windows-install-roots.js", () => ({
  getWindowsInstallRoots: () => ({
    systemRoot: "C:\\Windows",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    programW6432: null,
  }),
}));

import { resolveLsofCommandSync } from "./ports-lsof.js";
let cleanStaleGatewayProcessesSync: typeof import("./restart-stale-pids.js").cleanStaleGatewayProcessesSync;
let findGatewayPidsOnPortSync: typeof import("./restart-stale-pids.js").findGatewayPidsOnPortSync;

function lsofOutput(entries: Array<{ pid: number; cmd: string }>): string {
  return entries.map(({ pid, cmd }) => `p${pid}\nc${cmd}`).join("\n") + "\n";
}

type MockLsofResult = {
  error: Error | null;
  status: number | null;
  stdout: string;
  stderr: string;
};

type MockWindowsListeningPidsResult =
  | { ok: true; pids: number[] }
  | { ok: false; permanent: boolean };

type MockWindowsProcessArgsResult =
  | { ok: true; args: string[] | null }
  | { ok: false; permanent: boolean };

function createLsofResult(overrides: Partial<MockLsofResult> = {}): MockLsofResult {
  return {
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function createOpenClawBusyResult(pid: number, overrides: Partial<MockLsofResult> = {}) {
  return createLsofResult({
    stdout: lsofOutput([{ pid, cmd: "openclaw-gateway" }]),
    ...overrides,
  });
}

function createErrnoResult(code: string, message: string) {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return createLsofResult({ error, status: null });
}

function installInitialBusyPoll(
  stalePid: number,
  resolvePoll: (call: number) => MockLsofResult,
): () => number {
  let call = 0;
  mockSpawnSync.mockImplementation((command: unknown) => {
    if (command !== "lsof") {
      return createLsofResult();
    }
    call += 1;
    if (call === 1) {
      return createOpenClawBusyResult(stalePid);
    }
    return resolvePoll(call);
  });
  return () => call;
}

function mockCall(mock: ReturnType<typeof vi.fn>, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function mockCallRecordArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
  label: string,
): Record<string, unknown> {
  const value = mockCall(mock, callIndex)[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectWarningContaining(text: string): void {
  expect(
    mockRestartWarn.mock.calls.some((call) =>
      typeof call[0] === "string" ? call[0].includes(text) : false,
    ),
  ).toBe(true);
}

describe.skipIf(isWindows)("restart-stale-pids", () => {
  beforeAll(async () => {
    ({ cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
      await import("./restart-stale-pids.js"));
  });

  beforeEach(() => {
    mockSpawnSync.mockReset();
    mockResolveGatewayPort.mockReset();
    mockRestartWarn.mockReset();
    mockReadWindowsListeningPids.mockReset();
    mockReadWindowsListeningPidsResult.mockReset();
    mockReadWindowsProcessArgs.mockReset();
    mockReadWindowsProcessArgsResult.mockReset();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => {
      // Default: simulate /proc unavailable. Walks that reach this mock
      // degrade silently and return whatever set they collected so far.
      const error: NodeJS.ErrnoException = new Error("ENOENT: test default");
      error.code = "ENOENT";
      throw error;
    });
    mockResolveGatewayPort.mockReturnValue(18789);
    mockReadWindowsListeningPids.mockReturnValue([]);
    mockReadWindowsListeningPidsResult.mockReturnValue({ ok: true, pids: [] });
    mockReadWindowsProcessArgs.mockReturnValue(null);
    mockReadWindowsProcessArgsResult.mockReturnValue({ ok: true, args: null });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Temporarily overrides the parent PID for a block of test code. Used by the
  // ancestor-exclusion tests to drive the real `getSelfAndAncestorPidsSync`
  // walk without depending on runtime-specific `process.ppid` descriptors.
  function withStubbedPpid<T>(ppid: number, fn: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", { configurable: true, value: ppid });
    try {
      return fn();
    } finally {
      if (descriptor) {
        Object.defineProperty(process, "ppid", descriptor);
      }
    }
  }

  // -------------------------------------------------------------------------
  // findGatewayPidsOnPortSync
  // -------------------------------------------------------------------------
  describe("findGatewayPidsOnPortSync", () => {
    it("returns [] when lsof exits with non-zero status", () => {
      mockSpawnSync.mockReturnValue({ error: null, status: 1, stdout: "", stderr: "" });
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    });

    it("logs warning when initial lsof scan exits with status > 1", () => {
      mockSpawnSync.mockReturnValue({ error: null, status: 2, stdout: "", stderr: "lsof error" });
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
      expectWarningContaining("lsof exited with status 2");
    });

    it("silently skips the initial scan when lsof is missing", () => {
      mockSpawnSync.mockReturnValue(createErrnoResult("ENOENT", "lsof not found"));
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
      expect(mockRestartWarn).not.toHaveBeenCalled();
    });

    it.each([
      ["EACCES", "lsof permission denied"],
      ["ETIMEDOUT", "lsof timed out"],
    ])("warns when the initial lsof scan fails with %s", (code, message) => {
      mockSpawnSync.mockReturnValue(createErrnoResult(code, message));
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
      expectWarningContaining(`lsof failed during initial stale-pid scan for port 18789: ${code}`);
    });

    it("parses openclaw-gateway pids and excludes the current process", () => {
      const stalePid = process.pid + 1;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([
          { pid: stalePid, cmd: "openclaw-gateway" },
          { pid: process.pid, cmd: "openclaw-gateway" },
        ]),
        stderr: "",
      });
      const pids = findGatewayPidsOnPortSync(18789);
      expect(pids).toContain(stalePid);
      expect(pids).not.toContain(process.pid);
    });

    it("verifies argv when lsof reports the node process name instead of openclaw", () => {
      const stalePid = process.pid + 101;
      mockSpawnSync.mockImplementation((command: unknown) => {
        if (command === "ps") {
          return {
            error: null,
            status: 0,
            stdout: "node /opt/openclaw/dist/entry.js gateway\n",
            stderr: "",
          };
        }
        return {
          error: null,
          status: 0,
          stdout: lsofOutput([{ pid: stalePid, cmd: "cnode" }]),
          stderr: "",
        };
      });

      expect(findGatewayPidsOnPortSync(18789)).toEqual([stalePid]);
      const psCall = mockSpawnSync.mock.calls.find(
        (call) => call[0] === "ps" && Array.isArray(call[1]) && (call[1] as unknown[])[0] === "-ww",
      );
      expect(psCall?.[1]).toEqual(["-ww", "-p", String(stalePid), "-o", "command="]);
      expect(psCall?.[2]).toEqual({ encoding: "utf8", killSignal: "SIGKILL", timeout: 2000 });
    });

    it("skips malformed lsof pid tokens with trailing garbage", () => {
      const stalePid = process.pid + 102;
      mockSpawnSync.mockImplementation((command: unknown) => {
        if (command === "ps") {
          return {
            error: null,
            status: 0,
            stdout: "node /opt/openclaw/dist/entry.js gateway\n",
            stderr: "",
          };
        }
        return {
          error: null,
          status: 0,
          stdout: ["p111abc", "cnode", `p${stalePid}`, "cnode", ""].join("\n"),
          stderr: "",
        };
      });

      expect(findGatewayPidsOnPortSync(18789)).toEqual([stalePid]);
    });

    it("excludes ancestor pids so a sidecar cannot kill its parent gateway — regression for #68451", () => {
      // Regression: openclaw-weixin sidecar (child of the gateway) invoked
      // cleanStaleGatewayProcessesSync during init. lsof reported the parent
      // gateway on port 18789, its PID was not process.pid, so the cleanup
      // SIGTERM'd it — the supervisor restarted the gateway, re-spawned the
      // sidecar, the cleanup ran again: infinite restart loop.
      //
      // Fix: parsePidsFromLsofOutput now excludes process.pid AND its
      // ancestor chain (see getSelfAndAncestorPidsSync). This test stubs
      // process.ppid to the synthetic parent gateway pid so the real walk
      // adds it to the exclusion set; the default /proc mock throws ENOENT
      // so the walk stops after the direct parent.
      const parentGatewayPid = process.pid + 2001;
      const unrelatedStalePid = process.pid + 2002;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([
          { pid: parentGatewayPid, cmd: "openclaw-gateway" },
          { pid: unrelatedStalePid, cmd: "openclaw-gateway" },
        ]),
        stderr: "",
      });
      const pids = withStubbedPpid(parentGatewayPid, () => findGatewayPidsOnPortSync(18789));
      // Parent gateway must be excluded; an unrelated stale PID must still be
      // reported so the supervisor-path cleanup continues to work.
      expect(pids).not.toContain(parentGatewayPid);
      expect(pids).toContain(unrelatedStalePid);
    });

    it.skipIf(process.platform !== "linux")(
      "excludes the full ancestor chain, not just the direct parent — deeper nesting",
      () => {
        // The ancestor-exclusion invariant is transitive: killing any
        // ancestor cascades to the caller the same way killing the direct
        // parent does. Drive the real Linux /proc walk by stubbing
        // process.ppid to the direct parent and mocking readFileSync to
        // return synthetic PPid lines for each ancestor hop; the mock ends
        // the chain with "PPid: 0" so the walk terminates without touching
        // the real /proc.
        const directParentPid = process.pid + 2003;
        const grandparentPid = process.pid + 2004;
        const benignStalePid = process.pid + 2005;
        mockReadFileSync.mockImplementation((path: unknown): string => {
          if (path === `/proc/${directParentPid}/status`) {
            return `Name:\topenclaw-gateway\nPid:\t${directParentPid}\nPPid:\t${grandparentPid}\n`;
          }
          if (path === `/proc/${grandparentPid}/status`) {
            return `Name:\tsystemd\nPid:\t${grandparentPid}\nPPid:\t0\n`;
          }
          const error: NodeJS.ErrnoException = new Error("ENOENT");
          error.code = "ENOENT";
          throw error;
        });
        mockSpawnSync.mockReturnValue({
          error: null,
          status: 0,
          stdout: lsofOutput([
            { pid: directParentPid, cmd: "openclaw-gateway" },
            { pid: grandparentPid, cmd: "openclaw-gateway" },
            { pid: benignStalePid, cmd: "openclaw-gateway" },
          ]),
          stderr: "",
        });
        const pids = withStubbedPpid(directParentPid, () => findGatewayPidsOnPortSync(18789));
        expect(pids).not.toContain(directParentPid);
        expect(pids).not.toContain(grandparentPid);
        expect(pids).toContain(benignStalePid);
      },
    );

    it("excludes PID 1 when the direct parent gateway is the container entrypoint — container topology", () => {
      // Codex P1: in container deployments the gateway is the container
      // entrypoint and therefore runs as PID 1 of its namespace. A sidecar
      // spawned by that gateway has process.ppid === 1. An earlier revision
      // guarded the exclusion with `immediateParent > 1`, which dropped PID 1
      // and reopened the #68451 restart loop on every containerised install.
      // The current `> 0` check admits PID 1 into the exclusion set; this
      // test exercises the real walk by stubbing process.ppid to 1.
      const benignStalePid = process.pid + 2050;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([
          { pid: 1, cmd: "openclaw-gateway" },
          { pid: benignStalePid, cmd: "openclaw-gateway" },
        ]),
        stderr: "",
      });
      const pids = withStubbedPpid(1, () => findGatewayPidsOnPortSync(18789));
      expect(pids).not.toContain(1);
      expect(pids).toContain(benignStalePid);
    });

    it.skipIf(process.platform !== "linux")(
      "leaves the gateway grandparent in the kill list when /proc truncates the walk — documented degradation on hidepid/gVisor hosts",
      () => {
        // Pins the known-partial coverage the PR description and the
        // `readParentPidFromProc` comment call out: in hardened Linux
        // containers (hidepid=2, gVisor, AppArmor-locked namespaces) the
        // ancestor walk cannot traverse /proc/<other_pid>/status beyond
        // the caller, so it stops at `process.ppid`. For the direct-child
        // topology #68451 reports (gateway→sidecar), this is fine — ppid
        // is captured unconditionally via Node's syscall. For a 3-level
        // chain (gateway→plugin-host→sidecar), the gateway grandparent
        // falls outside the exclusion set and is still killable.
        //
        // This test locks that degraded outcome in place so a future
        // refactor cannot silently regress further (for example, by
        // skipping `process.ppid` as well) without at least failing this
        // assertion first. A fuller fix (macOS/Windows ancestor walk,
        // pidfd-based Linux walk, or privileged cmdline probe) belongs
        // in a separate change.
        const pluginHostPid = process.pid + 3001;
        const gatewayGrandparentPid = process.pid + 3002;
        // Default mockReadFileSync throws ENOENT for every /proc path —
        // the same view a non-privileged process has under hidepid=2.
        mockSpawnSync.mockReturnValue({
          error: null,
          status: 0,
          stdout: lsofOutput([
            { pid: pluginHostPid, cmd: "openclaw-gateway" },
            { pid: gatewayGrandparentPid, cmd: "openclaw-gateway" },
          ]),
          stderr: "",
        });
        const pids = withStubbedPpid(pluginHostPid, () => findGatewayPidsOnPortSync(18789));
        // Direct parent (plugin-host) must still be excluded — process.ppid
        // is captured with no /proc dependency, so hidepid cannot mask it.
        expect(pids).not.toContain(pluginHostPid);
        // Grandparent IS returned — documented partial coverage, tracked
        // separately from #68451.
        expect(pids).toContain(gatewayGrandparentPid);
      },
    );

    it("excludes the full ancestor chain on macOS via ps - nested in-band updater regression for #85120", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const toolHostPid = process.pid + 3101;
      const gatewayGrandparentPid = process.pid + 3102;
      const benignStalePid = process.pid + 3103;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        mockSpawnSync.mockImplementation((command: unknown, args: unknown) => {
          if (command === "ps" && Array.isArray(args) && args[0] === "-o") {
            const targetPid = args[3];
            if (targetPid === String(toolHostPid)) {
              return { error: null, status: 0, stdout: `${gatewayGrandparentPid}\n`, stderr: "" };
            }
            if (targetPid === String(gatewayGrandparentPid)) {
              return { error: null, status: 0, stdout: "1\n", stderr: "" };
            }
            return { error: null, status: 0, stdout: "0\n", stderr: "" };
          }
          return {
            error: null,
            status: 0,
            stdout: lsofOutput([
              { pid: toolHostPid, cmd: "openclaw-gateway" },
              { pid: gatewayGrandparentPid, cmd: "openclaw-gateway" },
              { pid: benignStalePid, cmd: "openclaw-gateway" },
            ]),
            stderr: "",
          };
        });

        const pids = withStubbedPpid(toolHostPid, () => findGatewayPidsOnPortSync(18789));
        expect(pids).not.toContain(toolHostPid);
        expect(pids).not.toContain(gatewayGrandparentPid);
        expect(pids).toContain(benignStalePid);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("excludes pids whose command does not include 'openclaw'", () => {
      const otherPid = process.pid + 2;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([{ pid: otherPid, cmd: "nginx" }]),
        stderr: "",
      });
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    });

    it("forwards the spawnTimeoutMs argument to spawnSync", () => {
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout: "", stderr: "" });
      findGatewayPidsOnPortSync(18789, 400);
      const lsofCall = mockCall(mockSpawnSync);
      expect(lsofCall[0]).toBe("lsof");
      expect(Array.isArray(lsofCall[1])).toBe(true);
      expect(mockCallRecordArg(mockSpawnSync, 0, 2, "lsof options").timeout).toBe(400);
    });

    it("uses the caller timeout for macOS ancestor ps probes", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const gatewayParentPid = process.pid + 3151;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        mockSpawnSync.mockImplementation((command: unknown, args: unknown) => {
          if (command === "ps" && Array.isArray(args) && args[0] === "-o") {
            return { error: null, status: 0, stdout: "1\n", stderr: "" };
          }
          return {
            error: null,
            status: 0,
            stdout: lsofOutput([{ pid: process.pid + 3152, cmd: "openclaw-gateway" }]),
            stderr: "",
          };
        });

        withStubbedPpid(gatewayParentPid, () => findGatewayPidsOnPortSync(18789, 400));
        const ancestorPsCall = mockSpawnSync.mock.calls.find(
          (call) =>
            call[0] === "ps" && Array.isArray(call[1]) && (call[1] as unknown[])[0] === "-o",
        );
        expect(ancestorPsCall?.[2]).toEqual({
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 400,
        });
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("deduplicates pids from dual-stack listeners (IPv4+IPv6 emit same pid twice)", () => {
      // Dual-stack listeners cause lsof to emit the same PID twice in -Fpc output
      // (once for the IPv4 socket, once for IPv6). Without dedup, terminateStaleProcessesSync
      // sends SIGTERM twice and returns killed=[pid, pid], corrupting the count.
      const stalePid = process.pid + 600;
      const stdout = `p${stalePid}\ncopenclaw-gateway\np${stalePid}\ncopenclaw-gateway\n`;
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout, stderr: "" });
      const result = findGatewayPidsOnPortSync(18789);
      expect(result).toEqual([stalePid]); // deduped — not [pid, pid]
    });

    it("delegates to Windows port helpers on win32 and skips lsof", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        mockReadWindowsListeningPids.mockReturnValue([]);
        expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
        expect(mockReadWindowsListeningPids).toHaveBeenCalledWith(18789, undefined);
        // lsof must NOT be invoked — Windows uses PowerShell/netstat
        expect(mockSpawnSync).not.toHaveBeenCalled();
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("returns verified gateway pids from Windows helpers on win32", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const stalePid = process.pid + 900;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        mockReadWindowsListeningPids.mockReturnValue([stalePid]);
        // Simulate a verified gateway process (must pass real isGatewayArgv)
        mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
        expect(findGatewayPidsOnPortSync(18789)).toEqual([stalePid]);
        expect(mockReadWindowsListeningPids).toHaveBeenCalledWith(18789, undefined);
        expect(mockReadWindowsProcessArgs).toHaveBeenCalledWith(stalePid, undefined);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("excludes ancestor pids on Windows too — #68451 regression mirror for the win32 path", () => {
      // The #68451 invariant must hold on every code path the cleanup can take.
      // The Windows filter (filterVerifiedWindowsGatewayPids) shares the same
      // exclusion source, so the direct-parent gateway PID must be dropped
      // before the argv-verification step runs. Drive the real walk on the
      // win32 branch (which stops at process.ppid — no /proc lookup) by
      // stubbing process.ppid to the synthetic parent pid.
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const parentGatewayPid = process.pid + 2101;
      const unrelatedStalePid = process.pid + 2102;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        mockReadWindowsListeningPids.mockReturnValue([parentGatewayPid, unrelatedStalePid]);
        mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
        const pids = withStubbedPpid(parentGatewayPid, () => findGatewayPidsOnPortSync(18789));
        expect(pids).not.toContain(parentGatewayPid);
        expect(pids).toContain(unrelatedStalePid);
        // argv verification must never have been asked about the parent, because
        // exclusion happens before the per-PID inspection step.
        expect(mockReadWindowsProcessArgs).not.toHaveBeenCalledWith(parentGatewayPid, undefined);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // parsePidsFromLsofOutput — pure unit tests (no I/O, driven via spawnSync mock)
  // -------------------------------------------------------------------------
  describe("parsePidsFromLsofOutput (via findGatewayPidsOnPortSync stdout path)", () => {
    it("returns [] for empty lsof stdout (status 0, nothing listening)", () => {
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout: "", stderr: "" });
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    });

    it("parses multiple openclaw pids from a single lsof output block", () => {
      const pid1 = process.pid + 10;
      const pid2 = process.pid + 11;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([
          { pid: pid1, cmd: "openclaw-gateway" },
          { pid: pid2, cmd: "openclaw-gateway" },
        ]),
        stderr: "",
      });
      const result = findGatewayPidsOnPortSync(18789);
      expect(result).toContain(pid1);
      expect(result).toContain(pid2);
    });

    it("returns [] when status 0 but only non-openclaw pids present", () => {
      // Port may be bound by an unrelated process. findGatewayPidsOnPortSync
      // only tracks openclaw processes — non-openclaw listeners are ignored.
      const otherPid = process.pid + 50;
      mockSpawnSync.mockReturnValue({
        error: null,
        status: 0,
        stdout: lsofOutput([{ pid: otherPid, cmd: "caddy" }]),
        stderr: "",
      });
      expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // pollPortOnce (via cleanStaleGatewayProcessesSync) — Codex P1 regression
  // -------------------------------------------------------------------------
  describe("pollPortOnce — no second lsof spawn (Codex P1 regression)", () => {
    it("treats lsof exit status 1 as port-free (no listeners)", () => {
      // lsof exits with status 1 when no matching processes are found — this is
      // the canonical "port is free" signal, not an error.
      const stalePid = process.pid + 500;
      installInitialBusyPoll(stalePid, () => createLsofResult({ status: 1 }));
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();
      expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    });

    it("treats lsof exit status >1 as inconclusive, not port-free — Codex P2 regression", () => {
      // Codex P2: non-zero lsof exits other than status 1 (e.g. permission denied,
      // bad flag, runtime error) must not be mapped to free:true. They are
      // inconclusive and should keep the polling loop running until budget expires.
      const stalePid = process.pid + 501;
      const events: string[] = [];
      events.push("initial-find");
      installInitialBusyPoll(stalePid, (call) => {
        if (call === 2) {
          // Permission/runtime error — status 2, should NOT be treated as free
          events.push("error-poll");
          return createLsofResult({ status: 2, stderr: "lsof: permission denied" });
        }
        // Eventually port is free
        events.push("free-poll");
        return createLsofResult({ status: 1 });
      });
      vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();

      // Must have continued polling after the status-2 error, not exited early
      expect(events).toContain("free-poll");
    });

    it("keeps polling when status 0 contains a malformed pid record", () => {
      const stalePid = process.pid + 502;
      const getCallCount = installInitialBusyPoll(stalePid, (call) =>
        call === 2
          ? createLsofResult({ stdout: "p111abc\ncopenclaw-gateway\n" })
          : createLsofResult({ status: 1 }),
      );

      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
      expect(getCallCount()).toBe(3);
    });

    it("does not make a second lsof call when the first returns status 0", () => {
      // The bug: pollPortOnce previously called findGatewayPidsOnPortSync as a
      // second probe after getting status===0 from the first lsof. That second
      // call collapses any error/timeout back into [], which maps to free:true —
      // silently misclassifying an inconclusive result as "port is free".
      //
      // The fix: pollPortOnce treats status 0 from the first spawnSync call as
      // occupied without a second lsof or PID parse.
      const stalePid = process.pid + 400;
      const getCallCount = installInitialBusyPoll(stalePid, (call) => {
        if (call === 2) {
          // First waitForPortFreeSync poll — status 0, port busy (should parse inline, not spawn again)
          return createOpenClawBusyResult(stalePid);
        }
        // Port free on third call
        return createLsofResult({ status: 1 });
      });

      vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();

      // If pollPortOnce made a second lsof call internally, spawnCount would
      // be at least 4 (initial + 2 polls each doubled). With the fix, each poll
      // is exactly one spawn: initial(1) + busy-poll(1) + free-poll(1) = 3.
      expect(getCallCount()).toBe(3);
    });

    it("lsof status 1 with non-empty openclaw stdout is treated as busy, not free (Linux container edge case)", () => {
      // On Linux containers with restricted /proc (AppArmor, seccomp, user namespaces),
      // lsof can exit 1 AND still emit output for processes it could read.
      // status 1 + non-empty openclaw stdout must not be treated as port-free.
      const stalePid = process.pid + 601;
      const getCallCount = installInitialBusyPoll(stalePid, (call) => {
        if (call === 2) {
          // status 1 + openclaw pid in stdout — container-restricted lsof reports partial results
          return createOpenClawBusyResult(stalePid, {
            status: 1,
            stderr: "lsof: WARNING: can't stat() fuse",
          });
        }
        // Third poll: port is genuinely free
        return createLsofResult({ status: 1 });
      });
      vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();
      // Poll 2 returned busy (not free), so we must have polled at least 3 times
      expect(getCallCount()).toBeGreaterThanOrEqual(3);
    });

    it("pollPortOnce outer catch returns { free: null, permanent: false } when resolveLsofCommandSync throws", () => {
      // If resolveLsofCommandSync throws (e.g. lsof resolution fails at runtime),
      // pollPortOnce must catch it and return the transient-inconclusive result
      // rather than propagating the exception.
      const stalePid = process.pid + 402;
      const mockedResolveLsof = vi.mocked(resolveLsofCommandSync);

      mockedResolveLsof.mockImplementationOnce(() => {
        // First call: initial findGatewayPidsOnPortSync — succeed normally
        return "lsof";
      });

      mockSpawnSync.mockImplementationOnce(() => {
        // Initial scan: finds stale pid
        return {
          error: null,
          status: 0,
          stdout: lsofOutput([{ pid: stalePid, cmd: "openclaw-gateway" }]),
          stderr: "",
        };
      });

      // Second call: poll — resolveLsofCommandSync throws
      mockedResolveLsof.mockImplementationOnce(() => {
        throw new Error("lsof binary resolution failed");
      });

      // Third call: poll — port is free
      mockedResolveLsof.mockImplementation(() => "lsof");
      mockSpawnSync.mockImplementation(() => ({ error: null, status: 1, stdout: "", stderr: "" }));

      vi.spyOn(process, "kill").mockReturnValue(true);
      // The catch path returns transient inconclusive, then the loop continues.
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
    });
  });

  // -------------------------------------------------------------------------
  // cleanStaleGatewayProcessesSync
  // -------------------------------------------------------------------------
  describe("cleanStaleGatewayProcessesSync", () => {
    it("returns [] and does not call process.kill when port has no listeners", () => {
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout: "", stderr: "" });
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("sends SIGTERM to stale pids and returns them", () => {
      const stalePid = process.pid + 100;
      installInitialBusyPoll(stalePid, () => createLsofResult({ status: 1 }));

      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const result = cleanStaleGatewayProcessesSync();

      expect(result).toContain(stalePid);
      expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    });

    it("continues cleanup and port polling when individual process signals fail", () => {
      const termDeniedPid = process.pid + 198;
      const killDeniedPid = process.pid + 199;
      let lsofCall = 0;
      mockSpawnSync.mockImplementation((command: unknown) => {
        if (command !== "lsof") {
          return createLsofResult();
        }
        lsofCall += 1;
        return lsofCall === 1
          ? createLsofResult({
              stdout: lsofOutput([
                { pid: termDeniedPid, cmd: "openclaw-gateway" },
                { pid: killDeniedPid, cmd: "openclaw-gateway" },
              ]),
            })
          : createLsofResult({ status: 1 });
      });

      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === termDeniedPid && signal === "SIGTERM") {
          throw Object.assign(new Error("term permission denied"), { code: "EPERM" });
        }
        if (pid === killDeniedPid && signal === "SIGKILL") {
          throw Object.assign(new Error("kill permission denied"), { code: "EACCES" });
        }
        return true;
      });

      expect(cleanStaleGatewayProcessesSync()).toEqual([killDeniedPid]);
      expect(killSpy).toHaveBeenCalledWith(termDeniedPid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(killDeniedPid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(killDeniedPid, 0);
      expect(killSpy).toHaveBeenCalledWith(killDeniedPid, "SIGKILL");
      expectWarningContaining(`failed to send SIGTERM to stale gateway process ${termDeniedPid}`);
      expectWarningContaining(`failed to send SIGKILL to stale gateway process ${killDeniedPid}`);
      expect(lsofCall).toBe(2);
    });

    it("does not kill a protected gateway pid after reparenting", () => {
      const protectedPid = process.pid + 4001;
      const stalePid = process.pid + 4002;
      let lsofCall = 0;
      mockSpawnSync.mockImplementation(() => {
        lsofCall += 1;
        return lsofCall === 1
          ? createLsofResult({
              stdout: lsofOutput([
                { pid: protectedPid, cmd: "openclaw-gateway" },
                { pid: stalePid, cmd: "openclaw-gateway" },
              ]),
            })
          : createLsofResult({ status: 1 });
      });
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      const result = withStubbedPpid(1, () =>
        cleanStaleGatewayProcessesSync(18789, { protectedPid }),
      );

      expect(result).toEqual([stalePid]);
      expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
      expect(killSpy).not.toHaveBeenCalledWith(protectedPid, expect.anything());
    });

    it("escalates to SIGKILL when process survives the SIGTERM window", () => {
      const stalePid = process.pid + 101;
      let call = 0;
      mockSpawnSync.mockImplementation(() => {
        call++;
        if (call <= 5) {
          return {
            error: null,
            status: 0,
            stdout: lsofOutput([{ pid: stalePid, cmd: "openclaw-gateway" }]),
            stderr: "",
          };
        }
        return createLsofResult({ status: 1 });
      });

      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();

      expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
    });

    it("polls until port is confirmed free before returning — regression for #33103", () => {
      // Core regression: cleanStaleGatewayProcessesSync must not return while
      // the port is still bound. Previously it returned after a fixed 500ms
      // sleep regardless of port state, causing systemd's new process to hit
      // EADDRINUSE and enter an unbounded restart loop.
      const stalePid = process.pid + 200;
      const events: string[] = [];
      let call = 0;

      mockSpawnSync.mockImplementation(() => {
        call++;
        if (call === 1) {
          events.push("initial-find");
          return {
            error: null,
            status: 0,
            stdout: lsofOutput([{ pid: stalePid, cmd: "openclaw-gateway" }]),
            stderr: "",
          };
        }
        if (call <= 4) {
          events.push(`busy-poll-${call}`);
          return {
            error: null,
            status: 0,
            stdout: lsofOutput([{ pid: stalePid, cmd: "openclaw-gateway" }]),
            stderr: "",
          };
        }
        events.push("port-free");
        return createLsofResult({ status: 1 });
      });

      vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();

      expect(events).toContain("port-free");
      expect(events.some((e) => e.startsWith("busy-poll"))).toBe(true);
    });

    it("bails immediately when lsof is permanently unavailable (ENOENT) — Greptile edge case", () => {
      // Regression for the edge case identified in PR review: lsof returning an
      // error must not be treated as "port free". ENOENT means lsof is not
      // installed — a permanent condition. The polling loop should bail
      // immediately on ENOENT rather than spinning the full 2-second budget.
      const stalePid = process.pid + 300;
      const events: string[] = [];
      events.push("initial-find");
      installInitialBusyPoll(stalePid, (call) => {
        // Permanent ENOENT — lsof is not installed
        events.push(`enoent-poll-${call}`);
        return createErrnoResult("ENOENT", "lsof not found");
      });

      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);

      // Must bail after first ENOENT poll — no point retrying a missing binary
      const enoentPolls = events.filter((e) => e.startsWith("enoent-poll"));
      expect(enoentPolls.length).toBe(1);
    });

    it("bails immediately when lsof is permanently unavailable (EPERM) — SELinux/AppArmor", () => {
      // EPERM occurs when lsof exists but a MAC policy (SELinux/AppArmor) blocks
      // execution. Like ENOENT/EACCES, this is permanent — retrying is pointless.
      const stalePid = process.pid + 305;
      const getCallCount = installInitialBusyPoll(stalePid, () =>
        createErrnoResult("EPERM", "lsof eperm"),
      );
      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
      // Must bail after exactly 1 EPERM poll — same as ENOENT/EACCES
      expect(getCallCount()).toBe(2); // 1 initial find + 1 EPERM poll
    });

    it("bails immediately when lsof is permanently unavailable (EACCES) — same as ENOENT", () => {
      // EACCES and EPERM are also permanent conditions — lsof exists but the
      // process has no permission to run it. No point retrying.
      const stalePid = process.pid + 302;
      const getCallCount = installInitialBusyPoll(stalePid, () =>
        createErrnoResult("EACCES", "lsof permission denied"),
      );
      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
      // Should have bailed after exactly 1 poll call (the EACCES one)
      expect(getCallCount()).toBe(2); // 1 initial find + 1 EACCES poll
    });

    it("proceeds with warning when polling budget is exhausted — fake clock, no real 2s wait", () => {
      // Sub-agent audit HIGH finding: the original test relied on real wall-clock
      // time (Date.now() + 2000ms deadline), burning 2 full seconds of CI time
      // every run. Mock the wall clock so the deadline can be synthesised
      // instantly, keeping the test under 10ms.
      const stalePid = process.pid + 303;
      let fakeNow = 0;
      vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

      installInitialBusyPoll(stalePid, () => {
        // Advance clock by PORT_FREE_TIMEOUT_MS + 1ms on first poll to trip the deadline.
        fakeNow += 2001;
        return createOpenClawBusyResult(stalePid);
      });

      vi.spyOn(process, "kill").mockReturnValue(true);
      // Proceeds with warning after budget expires.
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
    });

    it("still polls for port-free when all stale pids were already dead at SIGTERM time", () => {
      // Sub-agent audit MEDIUM finding: if all pids from the initial scan are
      // already dead before SIGTERM runs (race), terminateStaleProcessesSync
      // returns killed=[] — but cleanStaleGatewayProcessesSync MUST still call
      // waitForPortFreeSync. The process may have exited on its own while
      // leaving its socket in TIME_WAIT / FIN_WAIT. Skipping the poll would
      // silently recreate the EADDRINUSE race we are fixing.
      const stalePid = process.pid + 304;
      const events: string[] = [];

      events.push("initial-find");
      installInitialBusyPoll(stalePid, () => {
        // Port is already free on first poll — pid was dead before SIGTERM
        events.push("poll-free");
        return createLsofResult({ status: 1 });
      });

      // All SIGTERMs throw ESRCH — pid already gone
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      cleanStaleGatewayProcessesSync();

      // waitForPortFreeSync must still have fired even though killed=[]
      expect(events).toContain("poll-free");
    });

    it("continues polling on transient lsof errors (not ENOENT) — Codex P1 fix", () => {
      // A transient lsof error (spawnSync timeout, status 2, etc.) must NOT abort
      // the polling loop. The loop should keep retrying until the budget expires
      // or a definitive result is returned. Bailing on the first transient error
      // would recreate the EADDRINUSE race this PR is designed to prevent.
      const stalePid = process.pid + 301;
      const events: string[] = [];
      events.push("initial-find");
      installInitialBusyPoll(stalePid, (call) => {
        if (call === 2) {
          // Transient: spawnSync timeout (no ENOENT code)
          events.push("transient-error");
          return createLsofResult({ error: new Error("timeout"), status: null });
        }
        // Port free on the next poll
        events.push("port-free");
        return createLsofResult({ status: 1 });
      });

      vi.spyOn(process, "kill").mockReturnValue(true);
      cleanStaleGatewayProcessesSync();

      // Must have kept polling after the transient error and reached port-free
      expect(events).toContain("transient-error");
      expect(events).toContain("port-free");
    });

    it("returns gracefully when resolveGatewayPort throws", () => {
      mockResolveGatewayPort.mockImplementationOnce(() => {
        throw new Error("config read error");
      });
      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
    });

    it("returns gracefully when lsof is unavailable from the start", () => {
      mockSpawnSync.mockReturnValue({
        error: new Error("ENOENT"),
        status: null,
        stdout: "",
        stderr: "",
      });
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("treats failed Windows port probes as inconclusive, not free", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const stalePid = process.pid + 910;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        mockReadWindowsListeningPids.mockReturnValue([stalePid]);
        mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
        mockReadWindowsProcessArgsResult.mockReturnValue({
          ok: true,
          args: ["openclaw", "gateway"],
        });
        mockSpawnSync.mockReturnValue({
          error: null,
          status: 0,
          stdout: "",
          stderr: "",
        });
        let fakeNow = 0;
        vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
        mockReadWindowsListeningPidsResult.mockImplementation((_port, timeoutMs) => {
          if (timeoutMs === 400) {
            fakeNow += 2001;
            return { ok: false, permanent: false };
          }
          return { ok: true, pids: [stalePid] };
        });
        let aliveChecks = 0;
        const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (signal === 0 && pid === stalePid) {
            aliveChecks += 1;
            if (aliveChecks < 3) {
              return true;
            }
            throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          }
          return true;
        });

        expect(cleanStaleGatewayProcessesSync()).toEqual([stalePid]);
        expect(mockReadWindowsListeningPidsResult).toHaveBeenCalledWith(18789, 400);
        expectWarningContaining("port 18789 still in use after 2000ms");
        expect(killSpy).toHaveBeenCalledWith(stalePid, 0);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("waits for port release when the initial Windows stale-pid probe is inconclusive", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        let fakeNow = 0;
        vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
        mockReadWindowsListeningPidsResult.mockImplementation((_port, timeoutMs) => {
          if (timeoutMs === 400) {
            fakeNow += 2001;
          }
          return { ok: false, permanent: false };
        });
        const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

        expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
        expect(mockReadWindowsListeningPidsResult).toHaveBeenCalledWith(18789, 400);
        expectWarningContaining("port 18789 still in use after 2000ms");
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("waits for port release when Windows listener argv inspection is inconclusive", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const stalePid = process.pid + 913;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        let fakeNow = 0;
        vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
        mockReadWindowsListeningPidsResult.mockImplementation((_port, timeoutMs) => {
          if (timeoutMs === 400) {
            fakeNow += 2001;
          }
          return { ok: true, pids: [stalePid] };
        });
        mockReadWindowsProcessArgsResult.mockReturnValue({ ok: false, permanent: false });
        const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

        expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
        expect(mockReadWindowsProcessArgsResult).toHaveBeenCalledWith(stalePid, undefined);
        expectWarningContaining("port 18789 still in use after 2000ms");
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("does not report Windows pids as killed when taskkill fails", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const originalSystemRoot = process.env.SystemRoot;
      const stalePid = process.pid + 911;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.SystemRoot = "C:\\PoisonedWindows";
      try {
        let fakeNow = 0;
        vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
        mockReadWindowsListeningPids.mockReturnValue([stalePid]);
        mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
        mockReadWindowsProcessArgsResult.mockReturnValue({
          ok: true,
          args: ["openclaw", "gateway"],
        });
        mockReadWindowsListeningPidsResult.mockImplementation((_port, timeoutMs) => {
          if (timeoutMs === 400) {
            fakeNow += 2001;
          }
          return { ok: true, pids: [stalePid] };
        });
        mockSpawnSync.mockReturnValue({
          error: null,
          status: 1,
          stdout: "",
          stderr: "access denied",
        });
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (signal === 0 && pid === stalePid) {
            return true;
          }
          return true;
        });

        expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
        const taskkillCall = mockSpawnSync.mock.calls.find(
          (call) => call[0] === "C:\\Windows\\System32\\taskkill.exe",
        );
        expect(taskkillCall?.[1]).toEqual(["/T", "/PID", String(stalePid)]);
        expect((taskkillCall?.[2] as { timeout?: number } | undefined)?.timeout).toBe(5000);
      } finally {
        if (originalSystemRoot === undefined) {
          delete process.env.SystemRoot;
        } else {
          process.env.SystemRoot = originalSystemRoot;
        }
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });

    it("treats Windows EPERM liveness checks as alive and still forces taskkill", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const stalePid = process.pid + 912;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        let fakeNow = 0;
        vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
        mockReadWindowsListeningPidsResult.mockReturnValue({ ok: true, pids: [stalePid] });
        mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
        mockReadWindowsProcessArgsResult.mockReturnValue({
          ok: true,
          args: ["openclaw", "gateway"],
        });
        mockSpawnSync
          .mockReturnValueOnce({
            error: null,
            status: 1,
            stdout: "",
            stderr: "access denied",
          })
          .mockReturnValueOnce({
            error: null,
            status: 1,
            stdout: "",
            stderr: "still denied",
          });
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (signal === 0 && pid === stalePid) {
            throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          }
          return true;
        });
        vi.mocked(Atomics.wait).mockImplementation((_array, _index, _value, timeout) => {
          fakeNow += timeout ?? 0;
          return "timed-out";
        });

        expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
        expect(mockCall(mockSpawnSync, 0)[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
        expect(mockCall(mockSpawnSync, 0)[1]).toEqual(["/T", "/PID", String(stalePid)]);
        expect(mockCallRecordArg(mockSpawnSync, 0, 2, "taskkill options").timeout).toBe(5000);
        expect(mockCall(mockSpawnSync, 1)[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
        expect(mockCall(mockSpawnSync, 1)[1]).toEqual(["/F", "/T", "/PID", String(stalePid)]);
        expect(mockCallRecordArg(mockSpawnSync, 1, 2, "forced taskkill options").timeout).toBe(
          5000,
        );
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // parsePidsFromLsofOutput — branch-coverage for mid-loop && short-circuits
  // -------------------------------------------------------------------------
  describe("parsePidsFromLsofOutput — branch coverage (lines 67-69)", () => {
    it("skips a mid-loop entry when the command does not include 'openclaw'", () => {
      // Exercises the false branch of currentCmd.toLowerCase().includes("openclaw")
      // inside the mid-loop flush: a non-openclaw cmd between two entries must not
      // be pushed, but the following openclaw entry still must be.
      const stalePid = process.pid + 700;
      // Mixed output: non-openclaw entry first, then openclaw entry
      const stdout = `p${process.pid + 699}\ncnginx\np${stalePid}\ncopenclaw-gateway\n`;
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout, stderr: "" });
      const result = findGatewayPidsOnPortSync(18789);
      expect(result).toContain(stalePid);
      expect(result).not.toContain(process.pid + 699);
    });

    it("skips a mid-loop entry when currentCmd is missing (two consecutive p-lines)", () => {
      // Exercises currentCmd falsy branch mid-loop: two 'p' lines in a row
      // (no 'c' line between them) — the first PID must be skipped, the second handled.
      const stalePid = process.pid + 701;
      // Two consecutive p-lines: first has no c-line before the next p-line
      const stdout = `p${process.pid + 702}\np${stalePid}\ncopenclaw-gateway\n`;
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout, stderr: "" });
      const result = findGatewayPidsOnPortSync(18789);
      expect(result).toContain(stalePid);
    });

    it("ignores a p-line with an invalid (non-positive) PID — parse false branch", () => {
      // Exercises the parseStrictPositiveInteger failure branch: a malformed
      // 'p' line (e.g. 'p0' or 'pNaN') must not corrupt
      // currentPid and must not end up in the returned pids array.
      const stalePid = process.pid + 703;
      // p0 is invalid (not > 0); the following valid openclaw entry must still be found.
      const stdout = `p0\ncopenclaw-gateway\np${stalePid}\ncopenclaw-gateway\n`;
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout, stderr: "" });
      const result = findGatewayPidsOnPortSync(18789);
      expect(result).toContain(stalePid);
      expect(result).not.toContain(0);
    });

    it("silently skips lines that start with neither 'p' nor 'c' — else-if false branch", () => {
      // lsof -Fpc only emits 'p' and 'c' lines, but defensive handling of
      // unexpected output (e.g. 'f' for file descriptor in other lsof formats)
      // must not throw or corrupt the pid list. Unknown lines are just skipped.
      const stalePid = process.pid + 704;
      // Intersperse an 'f' line (file descriptor marker) — not a 'p' or 'c' line
      const stdout = `p${stalePid}\nf8\ncopenclaw-gateway\n`;
      mockSpawnSync.mockReturnValue({ error: null, status: 0, stdout, stderr: "" });
      const result = findGatewayPidsOnPortSync(18789);
      // The 'f' line must not corrupt parsing; stalePid must still be found
      // (the 'c' line after 'f' correctly sets currentCmd)
      expect(result).toContain(stalePid);
    });
  });

  // -------------------------------------------------------------------------
  // pollPortOnce branch — status 1 + non-empty stdout
  // -------------------------------------------------------------------------
  describe("pollPortOnce — status 1 + non-empty stdout", () => {
    it("keeps polling when status 1 includes a non-openclaw listener record", () => {
      const stalePid = process.pid + 800;
      const getCallCount = installInitialBusyPoll(stalePid, (call) => {
        if (call === 2) {
          return createLsofResult({
            status: 1,
            stdout: lsofOutput([{ pid: process.pid + 801, cmd: "caddy" }]),
          });
        }
        return createLsofResult({ status: 1 });
      });
      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(cleanStaleGatewayProcessesSync()).toContain(stalePid);
      expect(getCallCount()).toBe(3);
    });

    it("does not run macOS process argv probes while polling occupancy", () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const stalePid = process.pid + 810;
      const gatewayParentPid = process.pid + 811;
      let lsofCall = 0;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        mockSpawnSync.mockImplementation((command: unknown, args: unknown) => {
          if (command === "ps" && Array.isArray(args) && args[0] === "-o") {
            return { error: null, status: 0, stdout: "1\n", stderr: "" };
          }
          if (command === "lsof") {
            lsofCall += 1;
            if (lsofCall === 1) {
              return createOpenClawBusyResult(stalePid);
            }
            return lsofCall === 2
              ? createLsofResult({
                  stdout: lsofOutput([{ pid: gatewayParentPid, cmd: "openclaw-gateway" }]),
                })
              : createLsofResult({ status: 1 });
          }
          return createLsofResult();
        });

        vi.spyOn(process, "kill").mockReturnValue(true);
        const killed = withStubbedPpid(gatewayParentPid, () => cleanStaleGatewayProcessesSync());
        expect(killed).toContain(stalePid);
        const ancestorPsTimeouts = mockSpawnSync.mock.calls
          .filter(
            (call) =>
              call[0] === "ps" && Array.isArray(call[1]) && (call[1] as unknown[])[0] === "-o",
          )
          .map((call) => (call[2] as { timeout?: number } | undefined)?.timeout);
        expect(ancestorPsTimeouts).toContain(2000);
        expect(ancestorPsTimeouts).not.toContain(400);
        expect(lsofCall).toBe(3);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(process, "platform", origDescriptor);
        }
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
