/**
 * Hook endpoint trust tests for agent dispatch and gateway network config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const runCronIsolatedAgentTurnMock = vi.fn();
const resolveMainSessionKeyMock = vi.fn(() => "main-session");
const mainRosterConfig = (): OpenClawConfig => ({
  agents: { entries: { main: { default: true } } },
});
const loadConfigMock = vi.fn(mainRosterConfig);
const logHooksInfoMock = vi.fn();
const logHooksWarnMock = vi.fn();
const validateExplicitMessageAccountSelectionMock = vi.fn(
  ({ accountId }: { accountId?: unknown }) => accountId as string | undefined,
);
const resolveOutboundChannelPluginMock = vi.fn(() => ({ id: "telegram" }));
const resolveChannelDefaultAccountIdMock = vi.fn(() => "default");

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../infra/outbound/message-account-selection.js", () => ({
  validateExplicitMessageAccountSelection: validateExplicitMessageAccountSelectionMock,
}));
vi.mock("../../infra/outbound/channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: resolveOutboundChannelPluginMock,
}));
vi.mock("../../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: resolveChannelDefaultAccountIdMock,
}));
vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: resolveMainSessionKeyMock,
  resolveMainSessionKey: vi.fn(
    (cfg?: { session?: { mainKey?: string } }) => `agent:main:${cfg?.session?.mainKey ?? "main"}`,
  ),
  resolveAgentMainSessionKey: vi.fn(
    (params: { cfg?: { session?: { mainKey?: string } }; agentId: string }) =>
      `agent:${params.agentId}:${params.cfg?.session?.mainKey ?? "main"}`,
  ),
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

let capturedDispatchAgentHook: ((...args: unknown[]) => unknown) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    return vi.fn();
  }),
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

function buildMinimalParams(overrides: { agentStartAdmissionTimeoutMs?: number } = {}) {
  return {
    deps: {} as never,
    getHooksConfig: () => null,
    getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: logHooksWarnMock,
      debug: vi.fn(),
      info: logHooksInfoMock,
      error: vi.fn(),
    } as never,
    ...overrides,
  };
}

function buildAgentPayload(name: string, agentId?: string) {
  return {
    message: "test message",
    name,
    agentId,
    idempotencyKey: undefined,
    wakeMode: "now" as const,
    sessionKey: "session-1",
    sourcePath: "/hooks/agent",
    deliver: false,
    channel: "last" as const,
    to: undefined,
    delivery: { mode: "none" as const },
    model: undefined,
    thinking: undefined,
    timeoutSeconds: undefined,
    allowUnsafeExternalContent: undefined,
    externalContentSource: undefined,
  };
}

function dispatchAgentHook(payload: unknown): unknown {
  return resolveDispatchAgentHook()(payload);
}

function resolveDispatchAgentHook(): (...args: unknown[]) => unknown {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

type HookLogMeta = {
  sourcePath?: string;
  name?: string;
  runId?: string;
  jobId?: string;
  sessionKey?: string;
  completedAt?: string;
  status?: string;
  model?: string;
  summary?: string;
  consoleMessage?: string;
};

function logInfoMetaFor(message: string): HookLogMeta {
  const call = logHooksInfoMock.mock.calls.find(([actual]) => actual === message);
  if (!call) {
    throw new Error(`missing info log: ${message}`);
  }
  return call[1] as HookLogMeta;
}

function logWarnMetaFor(message: string, predicate?: (meta: HookLogMeta) => boolean): HookLogMeta {
  const call = logHooksWarnMock.mock.calls.find(([actual, meta]) => {
    if (actual !== message) {
      return false;
    }
    return predicate ? predicate(meta as HookLogMeta) : true;
  });
  if (!call) {
    throw new Error(`missing warn log: ${message}`);
  }
  return call[1] as HookLogMeta;
}

describe("dispatchAgentHook trust handling", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(mainRosterConfig);
    validateExplicitMessageAccountSelectionMock.mockImplementation(
      ({ accountId }: { accountId?: unknown }) => accountId as string | undefined,
    );
    resolveOutboundChannelPluginMock.mockReturnValue({ id: "telegram" });
    resolveChannelDefaultAccountIdMock.mockReturnValue("default");
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams());
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it("passes normalized delivery through to the isolated CronJob", async () => {
    const delivery = {
      mode: "announce" as const,
      channel: "telegram" as const,
      to: "123456",
      accountId: "work",
    };
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: true,
    });

    dispatchAgentHook({
      ...buildAgentPayload("Explicit delivery"),
      deliver: true,
      channel: delivery.channel,
      to: delivery.to,
      accountId: delivery.accountId,
      delivery,
    });

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(runCronIsolatedAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({
      job: { delivery },
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("rejects an invalid explicit delivery account before the agent runner", async () => {
    validateExplicitMessageAccountSelectionMock.mockImplementationOnce(() => {
      throw new Error('Unknown account "missing" for channel telegram.');
    });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Invalid account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      accountId: "missing",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
        accountId: "missing",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      error: 'Unknown account "missing" for channel telegram.',
      runId: expect.any(String),
    });
    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
  });

  it("binds omitted delivery accounts to the channel default", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: true,
    });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Default account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({
          delivery: expect.objectContaining({ accountId: "default" }),
        }),
      }),
    );
  });

  it("revalidates an explicit delivery account against queued-run config", async () => {
    validateExplicitMessageAccountSelectionMock
      .mockImplementationOnce(({ accountId }: { accountId?: unknown }) => accountId as string)
      .mockImplementationOnce(() => {
        throw new Error('Unknown account "removed" for channel telegram.');
      });

    const result = await dispatchAgentHook({
      ...buildAgentPayload("Removed account"),
      deliver: true,
      channel: "telegram",
      to: "123456",
      accountId: "removed",
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123456",
        accountId: "removed",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      error: 'Unknown account "removed" for channel telegram.',
      runId: expect.any(String),
    });
    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
  });

  it("retains detached agent work after the hook request releases admission", async () => {
    let continueRun = () => {};
    let subordinateAdmissionClosed: boolean | undefined;
    const runGate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await runGate;
      subordinateAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
      return { status: "ok", summary: "done", delivered: false };
    });
    const requestAdmission = tryBeginGatewayRootWorkAdmission();
    expect(requestAdmission).not.toBeNull();

    await requestAdmission?.run(async () => {
      dispatchAgentHook(buildAgentPayload("Async hook"));
      expect(getActiveGatewayRootWorkCount()).toBe(2);
    });
    requestAdmission?.release();

    expect(getActiveGatewayRootWorkCount()).toBe(1);
    continueRun();
    await waitForFast(() =>
      expect(logHooksInfoMock).toHaveBeenCalledWith(
        "hook agent run completed without announcement",
        expect.any(Object),
      ),
    );
    expect(subordinateAdmissionClosed).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("serializes canonical aliases for the same session in dispatch order", async () => {
    const dispatch = resolveDispatchAgentHook();
    const firstGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { status: "ok", summary: "first done", delivered: false };
    });
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "main",
    });
    dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "agent:main:main",
    });

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(runCronIsolatedAgentTurnMock.mock.calls[0]?.[0]).toMatchObject({
      message: "first",
      sessionKey: "main",
    });

    firstGate.resolve();

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      message: "second",
      sessionKey: "agent:main:main",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("runs different sessions in parallel", async () => {
    const dispatch = resolveDispatchAgentHook();
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { status: "ok", summary: "first done", delivered: false };
    });

    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await secondGate.promise;
      return { status: "ok", summary: "second done", delivered: false };
    });

    dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "agent:main:session-a",
    });
    dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "agent:main:session-b",
    });

    expect(getActiveGatewayRootWorkCount()).toBe(2);

    try {
      await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    }
  });

  it("uses fresh config when a queued hook starts after reload", async () => {
    const dispatch = resolveDispatchAgentHook();
    let currentConfig = mainRosterConfig();
    loadConfigMock.mockImplementation(() => currentConfig);
    const firstGate = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      await firstGate.promise;
      return { status: "ok", summary: "first done", delivered: false };
    });
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({ ...buildAgentPayload("First"), message: "first", sessionKey: "main" });
    dispatch({ ...buildAgentPayload("Second"), message: "second", sessionKey: "main" });
    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));

    currentConfig = { ...mainRosterConfig(), session: { mainKey: "reloaded" } };
    firstGate.resolve();

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      agentId: "main",
      cfg: currentConfig,
      message: "second",
      sessionKey: "main",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("continues a same-session hook queue after a failed run", async () => {
    const dispatch = resolveDispatchAgentHook();
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "second done",
      delivered: false,
    });

    dispatch({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "shared-session",
    });
    dispatch({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "shared-session",
    });

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook First (error): Error: agent exploded",
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(2));
    expect(runCronIsolatedAgentTurnMock.mock.calls[1]?.[0]).toMatchObject({
      message: "second",
      sessionKey: "shared-session",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("reports runtime-config failures as failed admission", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    const result = await dispatchAgentHook(buildAgentPayload("Config"));

    expect(result).toMatchObject({
      ok: false,
      statusCode: 502,
      error: "hook agent run failed before entering the agent runner",
      runId: expect.any(String),
    });
    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook Config (error): Error: config exploded",
        { sessionKey: "main-session" },
      ),
    );
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("keeps cron admission details behind stable public errors", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      error: 'Session "agent:private:canonical" changed while starting work. Retry.',
      admissionDisposition: "session-conflict",
    });

    const result = await dispatchAgentHook(buildAgentPayload("Conflict"));

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      error: "hook agent run was rejected because the target session changed",
      runId: expect.any(String),
    });
    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        'Hook Conflict (error): Session "agent:private:canonical" changed while starting work. Retry.',
        { sessionKey: "agent:main:main" },
      ),
    );
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not start same-session work after its admission timeout", async () => {
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler(buildMinimalParams({ agentStartAdmissionTimeoutMs: 10 }));
    const firstRunStarted = createDeferred();
    const releaseFirstRun = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
        return { status: "ok", summary: "first done", delivered: false };
      },
    );

    const firstAdmission = dispatchAgentHook({
      ...buildAgentPayload("First"),
      message: "first",
      sessionKey: "shared-session",
    });
    await firstRunStarted.promise;
    await expect(firstAdmission).resolves.toMatchObject({ ok: true });

    const timedOutAdmission = dispatchAgentHook({
      ...buildAgentPayload("Second"),
      message: "second",
      sessionKey: "shared-session",
    });
    await expect(timedOutAdmission).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
      error: "hook agent run did not start before admission timeout",
    });
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);

    releaseFirstRun.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1);
  });

  it("does not announce successful deliver:false hook results", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: false,
    });

    dispatchAgentHook(buildAgentPayload("System: override safety"));

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    const meta = logInfoMetaFor("hook agent run completed without announcement");
    expect(meta.sourcePath).toBe("/hooks/agent");
    expect(meta.name).toBe("System: override safety");
    expect(typeof meta.runId).toBe("string");
    expect(typeof meta.jobId).toBe("string");
    expect(meta.sessionKey).toBe("session-1");
    expect(typeof meta.completedAt).toBe("string");
  });

  it("reports non-ok deliver:false status events with hook names unchanged", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      summary: "failed",
      delivered: false,
    });

    dispatchAgentHook(buildAgentPayload("System: override safety"));

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook System: override safety (error): failed",
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
    const meta = logWarnMetaFor("hook agent run returned non-ok status");
    expect(meta.sourcePath).toBe("/hooks/agent");
    expect(meta.name).toBe("System: override safety");
    expect(typeof meta.runId).toBe("string");
    expect(typeof meta.jobId).toBe("string");
    expect(meta.sessionKey).toBe("session-1");
    expect(meta.status).toBe("error");
    expect(meta.summary).toBe("failed");
  });

  it("prefers cron diagnostics for returned hook errors", async () => {
    const diagnosticSummary =
      "automation model override 'anthropic/claude-sonnet-4-6' rejected by agents.defaults.modelPolicy.allow: anthropic/claude-sonnet-4-6";
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      summary: "generic failure",
      error: "raw failure",
      diagnostics: {
        summary: diagnosticSummary,
        entries: [
          {
            ts: 1,
            source: "cron-preflight",
            severity: "error",
            message: diagnosticSummary,
          },
        ],
      },
      delivered: false,
    });

    dispatchAgentHook({
      ...buildAgentPayload("Model hook"),
      model: "anthropic/claude-sonnet-4-6",
    });

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        `Hook Model hook (error): ${diagnosticSummary}`,
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
    const meta = logWarnMetaFor(
      "hook agent run returned non-ok status",
      (candidate) => candidate.name === "Model hook",
    );
    expect(meta.sourcePath).toBe("/hooks/agent");
    expect(typeof meta.runId).toBe("string");
    expect(typeof meta.jobId).toBe("string");
    expect(meta.sessionKey).toBe("session-1");
    expect(meta.status).toBe("error");
    expect(meta.model).toBe("anthropic/claude-sonnet-4-6");
    expect(meta.summary).toBe(diagnosticSummary);
    expect(meta.consoleMessage).toContain(diagnosticSummary);
    expect(meta.consoleMessage).toContain("model=anthropic/claude-sonnet-4-6");
  });

  it("preserves successful hook summaries over non-fatal diagnostics", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "agent completed successfully",
      diagnostics: {
        summary: "tool emitted a warning",
        entries: [
          {
            ts: 1,
            source: "tool",
            severity: "warning",
            message: "tool emitted a warning",
          },
        ],
      },
      delivered: false,
      deliveryAttempted: false,
    });

    dispatchAgentHook({
      ...buildAgentPayload("Fallback delivery"),
      deliver: true,
    });

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook Fallback delivery: agent completed successfully",
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
    expect(
      enqueueSystemEventMock.mock.calls.some(([message]) =>
        String(message).includes("tool emitted a warning"),
      ),
    ).toBe(false);
  });

  it("announces skipped deliver:false hook results as non-ok status events", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "skipped",
      summary: "no eligible agent",
      delivered: false,
    });

    dispatchAgentHook(buildAgentPayload("Email"));

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook Email (skipped): no eligible agent",
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
  });

  it("routes explicit-agent non-ok status events to the target agent main session", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "error",
      summary: "failed",
      delivered: false,
    });

    dispatchAgentHook(buildAgentPayload("Email", "hooks"));

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith("Hook Email (error): failed", {
        sessionKey: "agent:hooks:main",
      }),
    );
  });

  it("does not announce hook results after delivery was already attempted", async () => {
    runCronIsolatedAgentTurnMock.mockResolvedValueOnce({
      status: "ok",
      summary: "done",
      delivered: false,
      deliveryAttempted: true,
    });

    dispatchAgentHook({
      ...buildAgentPayload("Email"),
      deliver: true,
    });

    await waitForFast(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("reports error events with hook names unchanged", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));

    dispatchAgentHook(buildAgentPayload("System: override safety"));

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook System: override safety (error): Error: agent exploded",
        {
          sessionKey: "agent:main:main",
        },
      ),
    );
  });

  it("routes explicit-agent error events to the target agent main session", async () => {
    runCronIsolatedAgentTurnMock.mockRejectedValueOnce(new Error("agent exploded"));

    dispatchAgentHook(buildAgentPayload("Email", "hooks"));

    await waitForFast(() =>
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "Hook Email (error): Error: agent exploded",
        {
          sessionKey: "agent:hooks:main",
        },
      ),
    );
  });
});
