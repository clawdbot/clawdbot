import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const supervisorMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorMock.spawn,
  }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let buildExecExitOutcome: typeof import("./bash-tools.exec-runtime.js").buildExecExitOutcome;
let detectCursorKeyMode: typeof import("./bash-tools.exec-runtime.js").detectCursorKeyMode;
let emitExecSystemEvent: typeof import("./bash-tools.exec-runtime.js").emitExecSystemEvent;
let formatExecFailureReason: typeof import("./bash-tools.exec-runtime.js").formatExecFailureReason;
let renderExecUpdateText: typeof import("./bash-tools.exec-runtime.js").renderExecUpdateText;
let resolveExecTarget: typeof import("./bash-tools.exec-runtime.js").resolveExecTarget;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

beforeAll(async () => {
  ({ markBackgrounded } = await import("./bash-process-registry.js"));
  ({
    buildExecExitOutcome,
    detectCursorKeyMode,
    emitExecSystemEvent,
    formatExecFailureReason,
    renderExecUpdateText,
    resolveExecTarget,
    runExecProcess,
  } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  requestHeartbeatMock.mockClear();
  enqueueSystemEventMock.mockClear();
  supervisorMock.spawn.mockReset();
});

function expectExecTarget(
  actual: ReturnType<typeof resolveExecTarget>,
  expected: {
    configuredTarget: string;
    requestedTarget: string | null;
    selectedTarget: string;
    effectiveHost: string;
  },
) {
  expect(actual.configuredTarget).toBe(expected.configuredTarget);
  expect(actual.requestedTarget).toBe(expected.requestedTarget);
  expect(actual.selectedTarget).toBe(expected.selectedTarget);
  expect(actual.effectiveHost).toBe(expected.effectiveHost);
}

function requireSystemEventCall(): [string, Record<string, unknown>] {
  const call = enqueueSystemEventMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected system event call");
  }
  return call as [string, Record<string, unknown>];
}

function requireHeartbeatCall(): Record<string, unknown> {
  const call = requestHeartbeatMock.mock.calls.at(0);
  if (!call) {
    throw new Error("expected heartbeat call");
  }
  return call[0] as Record<string, unknown>;
}

describe("detectCursorKeyMode", () => {
  it("returns null when no toggle found", () => {
    expect(detectCursorKeyMode("hello world")).toBe(null);
    expect(detectCursorKeyMode("")).toBe(null);
  });

  it("detects smkx (application mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1h")).toBe("application");
    expect(detectCursorKeyMode("\x1b[?1h\x1b=")).toBe("application");
    expect(detectCursorKeyMode("before \x1b[?1h after")).toBe("application");
  });

  it("detects rmkx (normal mode)", () => {
    expect(detectCursorKeyMode("\x1b[?1l")).toBe("normal");
    expect(detectCursorKeyMode("\x1b[?1l\x1b>")).toBe("normal");
    expect(detectCursorKeyMode("before \x1b[?1l after")).toBe("normal");
  });

  it("last toggle wins when both present", () => {
    // smkx first, then rmkx - should be normal
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l")).toBe("normal");
    // rmkx first, then smkx - should be application
    expect(detectCursorKeyMode("\x1b[?1l\x1b[?1h")).toBe("application");
    // Multiple toggles - last one wins
    expect(detectCursorKeyMode("\x1b[?1h\x1b[?1l\x1b[?1h")).toBe("application");
  });
});

describe("resolveExecTarget", () => {
  it("keeps implicit auto on sandbox when a sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("keeps implicit auto on gateway when no sandbox runtime is available", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: null,
        selectedTarget: "auto",
        effectiveHost: "gateway",
      },
    );
  });

  it("allows per-call host=node override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("allows per-call host=gateway override when configured host is auto and no sandbox", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "gateway",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("rejects per-call host=gateway override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
    );
  });

  it("rejects per-call host=node override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested node; configured host is auto; set tools.exec.host=node to allow this override).",
    );
  });

  it("allows per-call host=sandbox override when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "sandbox",
        effectiveHost: "sandbox",
      },
    );
  });

  it("rejects cross-host override when configured target is a concrete host", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  it("allows explicit auto request when configured host is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "auto",
        selectedTarget: "auto",
        effectiveHost: "sandbox",
      },
    );
  });

  it("requires an exact match for non-auto configured targets", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "gateway",
        requestedTarget: "auto",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested auto; configured host is gateway; set tools.exec.host=auto to allow this override).",
    );
  });

  it("allows exact node matches", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("forces elevated requests onto the gateway host when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        elevatedRequested: true,
        sandboxAvailable: true,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "sandbox",
        selectedTarget: "gateway",
        effectiveHost: "gateway",
      },
    );
  });

  it("keeps explicit node override under elevated requests when configured target is auto", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "auto",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("honours node target for elevated requests when configured target is node", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: "node",
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("routes to node for elevated when configured=node and no per-call override", () => {
    expectExecTarget(
      resolveExecTarget({
        configuredTarget: "node",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
      {
        configuredTarget: "node",
        requestedTarget: null,
        selectedTarget: "node",
        effectiveHost: "node",
      },
    );
  });

  it("rejects mismatched requestedTarget under elevated+node", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });
});

describe("renderExecUpdateText", () => {
  it("uses a non-empty placeholder when an exec update has no output", () => {
    expect(renderExecUpdateText({ tailText: "", warnings: [] })).toBe("(no output)");
  });

  it("preserves non-empty exec output", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: [] })).toBe("hello");
  });

  it("keeps warnings while still avoiding empty output text", () => {
    expect(renderExecUpdateText({ tailText: "", warnings: ["Warning: retrying"] })).toBe(
      "Warning: retrying\n\n(no output)",
    );
  });

  it("combines warnings with non-empty output", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: ["Warning: retrying"] })).toBe(
      "Warning: retrying\n\nhello",
    );
  });
});

describe("exec notifyOnExit suppression", () => {
  async function runBackgroundedExit(params: {
    reason: "manual-cancel" | "overall-timeout";
    stdout?: string;
  }) {
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => {
        if (params.stdout) {
          input.onStdout?.(params.stdout);
        }
        return {
          runId: "run-1",
          startedAtMs: Date.now(),
          pid: 123,
          wait: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return {
              reason: params.reason,
              exitCode: null,
              exitSignal: "SIGKILL",
              durationMs: 10,
              stdout: "",
              stderr: "",
              timedOut: params.reason === "overall-timeout",
              noOutputTimedOut: false,
            };
          },
          cancel: vi.fn(),
        };
      },
    );

    const run = await runExecProcess({
      command: "sleep 999",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      sessionKey: "agent:main:main",
      timeoutSec: null,
    });
    markBackgrounded(run.session);
    return await run.promise;
  }

  it("keeps manual-cancelled no-output background execs silent", async () => {
    const outcome = await runBackgroundedExit({ reason: "manual-cancel" });

    expect(outcome.status).toBe("failed");
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("notifies for manual-cancelled background execs with output", async () => {
    await runBackgroundedExit({ reason: "manual-cancel", stdout: "partial output\n" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("partial output");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });

  it("still notifies for no-output background exec timeouts", async () => {
    await runBackgroundedExit({ reason: "overall-timeout" });

    const [message, options] = requireSystemEventCall();
    expect(message).toContain("Exec failed");
    expect(options.sessionKey).toBe("agent:main:main");
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:main:main");
  });
});

describe("emitExecSystemEvent", () => {
  beforeEach(() => {
    requestHeartbeatMock.mockClear();
    enqueueSystemEventMock.mockClear();
  });

  it("scopes heartbeat wake to the event session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-100123:topic:47",
        threadId: 47,
      },
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "agent:ops:main",
      contextKey: "exec:run-1",
      deliveryContext: {
        channel: "telegram",
        to: "telegram:-100123:topic:47",
        threadId: 47,
      },
      trusted: false,
    });
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
    expect(heartbeat.sessionKey).toBe("agent:ops:main");
  });

  it("remaps cron-run event enqueue and wake targets to the drained agent main session", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:cron:nightly:run:run-1",
      contextKey: "exec:run-cron",
      mainKey: "primary",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "agent:ops:primary",
      contextKey: "exec:run-cron",
      trusted: false,
    });
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const [[heartbeatParams]] = requestHeartbeatMock.mock.calls as unknown as Array<
      [{ coalesceMs?: number; reason?: string; sessionKey?: string }]
    >;
    expect(heartbeatParams.coalesceMs).toBe(0);
    expect(heartbeatParams.reason).toBe("exec-event");
    expect(heartbeatParams.sessionKey).toBe("agent:ops:primary");
  });

  it("routes global-scope cron-run events to the global queue and preserves the agent wake target", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "agent:ops:cron:nightly:run:run-1:subagent:worker",
      contextKey: "exec:run-global",
      sessionScope: "global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
      trusted: false,
    });
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    const [[heartbeatParams]] = requestHeartbeatMock.mock.calls as unknown as Array<
      [{ agentId?: string; coalesceMs?: number; reason?: string }]
    >;
    expect(heartbeatParams.agentId).toBe("ops");
    expect(heartbeatParams.coalesceMs).toBe(0);
    expect(heartbeatParams.reason).toBe("exec-event");
    expect(requestHeartbeatMock.mock.calls.at(0)?.[0]).not.toHaveProperty("sessionKey");
  });

  it("keeps wake unscoped for non-agent session keys", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Exec finished", {
      sessionKey: "global",
      contextKey: "exec:run-global",
      trusted: false,
    });
    const heartbeat = requireHeartbeatCall();
    expect(heartbeat.coalesceMs).toBe(0);
    expect(heartbeat.reason).toBe("exec-event");
  });

  it("ignores events without a session key", () => {
    emitExecSystemEvent("Exec finished", {
      sessionKey: "  ",
      contextKey: "exec:run-2",
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });
});

describe("formatExecFailureReason", () => {
  it("formats timeout guidance with the configured timeout", () => {
    expect(
      formatExecFailureReason({
        failureKind: "overall-timeout",
        exitSignal: "SIGKILL",
        timeoutSec: 45,
      }),
    ).toContain("45 seconds");
  });

  it("points long-running work to registered exec backgrounding", () => {
    const reason = formatExecFailureReason({
      failureKind: "overall-timeout",
      exitSignal: "SIGKILL",
      timeoutSec: 45,
    });

    expect(reason).toContain("background=true");
    expect(reason).toContain("yieldMs");
    expect(reason).toContain("Do not rely on shell backgrounding");
  });

  it("formats shell failures without timeout-specific guidance", () => {
    expect(
      formatExecFailureReason({
        failureKind: "shell-command-not-found",
        exitSignal: null,
        timeoutSec: 45,
      }),
    ).toBe("Command not found");
  });
});

describe("buildExecExitOutcome", () => {
  it("keeps non-zero normal exits in the completed path", () => {
    const outcome = buildExecExitOutcome({
      exit: {
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      },
      aggregated: "done",
      durationMs: 123,
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error(`Expected completed outcome, got ${outcome.status}`);
    }
    expect(outcome.exitCode).toBe(1);
    expect(outcome.aggregated).toBe("done\n\n(Command exited with code 1)");
  });

  it("classifies timed out exits as failures with a reason", () => {
    const outcome = buildExecExitOutcome({
      exit: {
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      },
      aggregated: "",
      durationMs: 123,
      timeoutSec: 30,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") {
      throw new Error(`Expected timeout to fail, got ${outcome.status}`);
    }
    expect(outcome.failureKind).toBe("overall-timeout");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.reason).toContain("30 seconds");
  });

  it("keeps timed out shell-backgrounded commands on the failed path", () => {
    const outcome = buildExecExitOutcome({
      exit: {
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 123,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      },
      aggregated: "started worker",
      durationMs: 123,
      timeoutSec: 30,
    });

    if (outcome.status !== "failed") {
      throw new Error(`Expected timeout to fail, got ${outcome.status}`);
    }
    expect(outcome.failureKind).toBe("overall-timeout");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.reason).toContain("background=true");
    expect(outcome.reason).toContain("Do not rely on shell backgrounding");
  });
});
