// Native hook relay CLI tests cover relay command registration and runtime delegation.
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installParentDeathWatchLinux,
  readProcStat as parseProcStat,
  runNativeHookRelayCli,
  runNativeHookRelayCliFromArgv,
} from "./native-hook-relay-cli.js";

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: mockReadFileSync };
});

function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

function createWritableTextBuffer(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}

describe("native hook relay CLI", () => {
  it("parses the internal cold-path argument vector", async () => {
    const invokeBridge = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      runNativeHookRelayCliFromArgv(
        [
          "node",
          "openclaw.mjs",
          "hooks",
          "relay",
          "--provider=codex",
          "--relay-id",
          "relay-1",
          "--state-db",
          "/tmp/profile/state/openclaw.sqlite",
          "--generation",
          "generation-1",
          "--event",
          "pre_tool_use",
          "--pre-tool-use-unavailable",
          "noop",
          "--timeout",
          "1234",
        ],
        {
          stdin: createReadableTextStream("{}"),
          invokeBridge: invokeBridge as never,
        },
      ),
    ).resolves.toBe(0);

    expect(invokeBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        relayId: "relay-1",
        stateDbPath: "/tmp/profile/state/openclaw.sqlite",
        generation: "generation-1",
        event: "pre_tool_use",
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("passes the explicit state database path to direct bridge lookup", async () => {
    const invokeBridge = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          stateDb: "/tmp/profile/state/openclaw.sqlite",
          generation: "generation-1",
          event: "post_tool_use",
        },
        {
          stdin: createReadableTextStream("{}"),
          invokeBridge: invokeBridge as never,
        },
      ),
    ).resolves.toBe(0);

    expect(invokeBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        relayId: "relay-1",
        stateDbPath: "/tmp/profile/state/openclaw.sqlite",
      }),
    );
  });

  it("reads Codex hook JSON from stdin and forwards it to the gateway relay", async () => {
    const callGateway = vi.fn(async (_opts: unknown) => ({ stdout: "", stderr: "", exitCode: 0 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1234",
      },
      {
        stdin: createReadableTextStream(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          }),
        ),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    expect(callGateway).toHaveBeenCalledWith({
      method: "nativeHook.invoke",
      params: {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      },
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      scopes: ["operator.admin"],
    });
    const call = callGateway.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined;
    expect(call).toBeDefined();
    expect(call?.timeoutMs).toBeGreaterThan(0);
    expect(call?.timeoutMs).toBeLessThanOrEqual(1234);
  });

  it("renders provider-compatible stdout, stderr, and exit code from the gateway response", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 2 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("out");
    expect(stderr.text()).toBe("err");
  });

  it("rejects malformed timeouts before reading relay input", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "5000ms",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("invalid native hook timeout");
    expect(stderr.text()).toContain('Received: "5000ms"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects fractional timeouts before gateway fallback", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1.5",
      },
      {
        stdin: createReadableTextStream("{}"),
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain('Received: "1.5"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("renders unavailable output for legacy relay commands without a generation", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const callGateway = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    expect(stderr.text()).toContain("generation must be non-empty string");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nativeHook.invoke",
        params: expect.objectContaining({ generation: undefined }),
      }),
    );
  });

  it.each([
    {
      event: "pre_tool_use",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay unavailable",
        },
      },
    },
    {
      event: "permission_request",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Native hook relay unavailable",
          },
        },
      },
    },
    {
      event: "post_tool_use",
      stdout: null,
    },
  ])(
    "does not fall back to the gateway after a stale direct bridge error for $event",
    async (testCase) => {
      const invokeBridge = vi.fn(async () => {
        throw new Error("native hook relay bridge stale registration");
      });
      const callGateway = vi.fn(async () => ({ stdout: "unexpected", stderr: "", exitCode: 0 }));
      const stdout = createWritableTextBuffer();
      const stderr = createWritableTextBuffer();

      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: testCase.event,
        },
        {
          stdin: createReadableTextStream("{}"),
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      if (testCase.stdout) {
        expect(JSON.parse(stdout.text())).toEqual(testCase.stdout);
      } else {
        expect(stdout.text()).toBe("");
      }
      expect(stderr.text()).toContain("native hook relay unavailable");
      expect(stderr.text()).toContain("native hook relay bridge stale registration");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("returns a nonzero code for malformed hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{nope"),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("failed to read native hook input");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      stdout: null,
    },
    {
      event: "pre_tool_use",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay timed out",
        },
      },
    },
    {
      event: "permission_request",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Native hook relay timed out",
          },
        },
      },
    },
    {
      event: "post_tool_use",
      stdout: null,
    },
  ])(
    "bounds valid $event hook input that never reaches EOF",
    async (testCase) => {
      const invokeBridge = vi.fn();
      const callGateway = vi.fn();
      const stdin = createHeldOpenTextStream("{}");
      const stdout = createWritableTextBuffer();
      const stderr = createWritableTextBuffer();

      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: testCase.event,
          preToolUseUnavailable: testCase.preToolUseUnavailable,
          timeout: "25",
        },
        {
          stdin,
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      if (testCase.stdout) {
        expect(JSON.parse(stdout.text())).toEqual(testCase.stdout);
      } else {
        expect(stdout.text()).toBe("");
      }
      expect(stderr.text()).toContain("native hook relay timed out");
      expect(stdin.destroyed).toBe(true);
      expect(invokeBridge).not.toHaveBeenCalled();
      expect(callGateway).not.toHaveBeenCalled();
    },
    1_000,
  );

  it("applies the relay deadline to gateway fallback", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("bridge unavailable");
    });
    const callGateway = vi.fn(async () => await new Promise<never>(() => {}));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "post_tool_use",
        timeout: "25",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay timed out");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nativeHook.invoke",
        signal: expect.any(AbortSignal),
      }),
    );
  }, 1_000);

  it("handles bridge rejection when the deadline expires during bridge startup", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const invokeBridge = vi.fn(() => {
      now = 26;
      return Promise.reject(new Error("native hook relay bridge not found"));
    });
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    try {
      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: "pre_tool_use",
          timeout: "25",
        },
        {
          stdin: createReadableTextStream("{}"),
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay timed out",
        },
      });
      expect(stderr.text()).toContain("native hook relay timed out");
      expect(invokeBridge).toHaveBeenCalledOnce();
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects oversized hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("x".repeat(1024 * 1024 + 1)),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("native hook input exceeds");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed for PreToolUse when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps PreToolUse unavailable handling observational only with an explicit no-policy marker", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        preToolUseUnavailable: "noop",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("fails closed for PermissionRequest when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Native hook relay unavailable",
        },
      },
    });
  });

  it("keeps PostToolUse unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps before_agent_finalize unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "before_agent_finalize",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });
});

function createHeldOpenTextStream(text: string): PassThrough {
  const stream = new PassThrough();
  stream.write(text);
  return stream;
}

describe("parent death watch", () => {
  const PARENT_PID = 88888;
  const PARENT_START_TIME = 12345;
  const SELF_START_TIME = 67890;

  type MockProcStatResult =
    | { status: "present"; startTime: number; ppid: number }
    | { status: "missing" }
    | { status: "unreadable" };

  function makeProcStat(
    pid: number,
    ppid: number,
    startTime: number,
  ): { status: "present"; startTime: number; ppid: number } {
    return { status: "present" as const, startTime, ppid };
  }

  function makeMissing(): { status: "missing" } {
    return { status: "missing" as const };
  }

  function makeUnreadable(): { status: "unreadable" } {
    return { status: "unreadable" as const };
  }

  function createReadProcStatMock(
    opts: {
      parentAlive?: boolean;
      parentStartTime?: number;
      selfPpid?: number;
    } = {},
  ) {
    const parentAlive = opts.parentAlive ?? true;
    const parentStartTime = opts.parentStartTime ?? PARENT_START_TIME;
    const selfPpid = opts.selfPpid ?? PARENT_PID;
    return vi.fn<(pid: number) => MockProcStatResult>((pid) => {
      if (pid === PARENT_PID) {
        if (!parentAlive) {
          return makeMissing();
        }
        return makeProcStat(PARENT_PID, 1, parentStartTime);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, selfPpid, SELF_START_TIME);
      }
      return makeMissing();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts a periodic poll on Linux", () => {
    const readProcStat = createReadProcStatMock();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const watch = installParentDeathWatchLinux(PARENT_PID, { readProcStat });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    watch.dispose();
  });

  it("does not exit while the parent stays alive", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = createReadProcStatMock();

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("exits immediately when the parent is already gone at startup", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = createReadProcStatMock({ parentAlive: false });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("exits when the parent /proc entry disappears", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    // Tick 1: parent alive.
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 2: parent proc entry gone → exit(0).
    readProcStat.mockReturnValue(makeMissing());
    vi.advanceTimersByTime(5000);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("exits when the parent start time changes (PID reuse)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    // Tick 1: parent start time matches → no exit.
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 2: PID was reused, start time differs → exit(0).
    readProcStat.mockImplementation((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, 99999);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });
    vi.advanceTimersByTime(5000);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("exits when the relay is reparented (self ppid changed)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    // Tick 1: ppid matches → no exit.
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 2: reparented to PID 1 → exit(0).
    readProcStat.mockImplementation((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, 1, SELF_START_TIME);
      }
      return makeMissing();
    });
    vi.advanceTimersByTime(5000);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("dispose stops the watch and prevents further ticks", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = createReadProcStatMock();

    const watch = installParentDeathWatchLinux(PARENT_PID, { readProcStat });
    watch.dispose();

    // Advance well past several intervals — nothing should fire.
    vi.advanceTimersByTime(30000);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("does not exit when the parent /proc entry is unreadable at poll time", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    // Tick 1: parent alive.
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 2: parent proc entry unreadable (transient I/O) — do not exit.
    readProcStat.mockReturnValue(makeUnreadable());
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 3: still unreadable — still not exiting; relay deadline bounds this.
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("does not exit at startup when the parent /proc entry is unreadable", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeUnreadable();
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    // Startup: unreadable parent — do not exit.
    expect(exitSpy).not.toHaveBeenCalled();

    // First poll: parent now readable — still alive.
    readProcStat.mockImplementation((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        return makeProcStat(process.pid, PARENT_PID, SELF_START_TIME);
      }
      return makeMissing();
    });
    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("does not exit when self-stat is unreadable during the reparenting check", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const readProcStat = vi.fn((pid: number) => {
      if (pid === PARENT_PID) {
        return makeProcStat(PARENT_PID, 1, PARENT_START_TIME);
      }
      if (pid === process.pid) {
        // Self-stat unreadable but parent still alive — keep polling.
        return makeUnreadable();
      }
      return makeMissing();
    });

    installParentDeathWatchLinux(PARENT_PID, { readProcStat });

    vi.advanceTimersByTime(5000);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("skips the watch in runNativeHookRelayCli on non-Linux platforms", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
      writable: true,
    });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const invokeBridge = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await runNativeHookRelayCli(
      { provider: "codex", relayId: "r1", generation: "g1", event: "pre_tool_use" },
      { stdin: createReadableTextStream("{}"), invokeBridge: invokeBridge as never },
    );

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  describe("readProcStat field validation", () => {
    beforeEach(() => {
      mockReadFileSync.mockReset();
    });

    it("returns unreadable when proc stat has no closing paren", () => {
      // Missing ")" makes the comm field unparseable.
      mockReadFileSync.mockReturnValue(
        "1234 (comm S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23",
      );
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });

    it("returns unreadable when proc stat has too few fields", () => {
      // Only 5 fields after comm — not enough for ppid (index 1) and
      // starttime (index 19).
      mockReadFileSync.mockReturnValue("1234 (comm) S 1 2 3");
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });

    it("returns unreadable when ppid is non-numeric", () => {
      const fields = Array(25).fill("0");
      fields[0] = "abc";
      mockReadFileSync.mockReturnValue(`1234 (comm) S ${fields.join(" ")}`);
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });

    it("returns unreadable when starttime is non-numeric", () => {
      const fields = Array(25).fill("0");
      fields[18] = "xyz";
      mockReadFileSync.mockReturnValue(`1234 (comm) S ${fields.join(" ")}`);
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });

    it("returns unreadable when starttime is negative", () => {
      const fields = Array(25).fill("0");
      fields[18] = "-1";
      mockReadFileSync.mockReturnValue(`1234 (comm) S ${fields.join(" ")}`);
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });

    it("returns present with valid proc stat fields", () => {
      const fields = Array(25).fill("0");
      fields[0] = "1";
      fields[18] = "12345";
      mockReadFileSync.mockReturnValue(`1234 (comm) S ${fields.join(" ")}`);
      expect(parseProcStat(1234)).toEqual({ status: "present", ppid: 1, startTime: 12345 });
    });

    it("returns missing for ENOENT errors", () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockReadFileSync.mockImplementation(() => {
        throw err;
      });
      expect(parseProcStat(99999)).toEqual({ status: "missing" });
    });

    it("returns unreadable for non-ENOENT errors", () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      mockReadFileSync.mockImplementation(() => {
        throw err;
      });
      expect(parseProcStat(1234)).toEqual({ status: "unreadable" });
    });
  });
});
