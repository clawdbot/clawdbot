import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AcpRuntime, AcpRuntimeTurnInput } from "@openclaw/acp-core/runtime/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { consumeAcpTurnStream } from "../../acp/control-plane/manager.turn-stream.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { HookMappingConfig } from "../../config/types.hooks.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import { resolveSystemEventOptionsOwnerAgentId } from "../../infra/system-event-ownership.js";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import {
  applyLoggingConfig,
  flushLogger,
  resetLogger,
  setLoggerOverride,
} from "../../logging/logger.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import { loggingState } from "../../logging/state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveHooksConfig } from "../hooks.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "../server-lanes.js";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  requestHeartbeat: vi.fn(),
  runCronIsolatedAgentTurn: vi.fn(),
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: mocks.runCronIsolatedAgentTurn,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: mocks.requestHeartbeat,
}));
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

const { createGatewayHookDispatcher, createGatewayHooksRequestHandler } =
  await import("./hooks.js");

const pluginHookTurn = {
  name: "IMAP fastmail",
  agentId: "hooks",
  sessionKey: "hook:imap:fastmail:11:42",
  message: "New untrusted email",
  externalContentSource: "email" as const,
  deliver: false,
};

function createPluginHookDispatcher(options: { admissionTimeoutMs?: number } = {}) {
  const logHooks = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  const dispatcher = createGatewayHookDispatcher({
    deps: {} as never,
    logHooks: logHooks as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  return { dispatcher, logHooks };
}

function queueHookRunner(onStart = vi.fn()) {
  mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
    async (params: { lane: string; onExecutionStarted?: () => void }) =>
      await enqueueCommandInLane(params.lane, async () => {
        params.onExecutionStarted?.();
        onStart();
        return { status: "ok", summary: "done" };
      }),
  );
  return onStart;
}

function createConfig(global: boolean): OpenClawConfig {
  return {
    agents: { entries: { main: { default: true }, hooks: {} } },
    hooks: { enabled: true, token: "hook-secret" },
    ...(global ? { session: { scope: "global" } } : {}),
  };
}

async function postAgentHook(
  global: boolean,
  options: {
    admissionTimeoutMs?: number;
    rejectInitialConfig?: boolean;
    mapping?: HookMappingConfig;
    logger?: ReturnType<typeof createSubsystemLogger>;
  } = {},
) {
  const config = createConfig(global);
  if (options.mapping) {
    config.hooks = { ...config.hooks, mappings: [options.mapping] };
  }
  const hooksConfig = resolveHooksConfig(config);
  if (!hooksConfig) {
    throw new Error("expected resolved hooks config");
  }
  const logHooks = {
    warn: vi.fn(options.logger?.warn),
    debug: vi.fn(),
    info: vi.fn(options.logger?.info),
    error: vi.fn(),
  };
  const handler = createGatewayHooksRequestHandler({
    deps: {} as never,
    getHooksConfig: () => hooksConfig,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: logHooks as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  const req = Object.assign(
    Readable.from([JSON.stringify({ message: "Dispatch", name: "Recovery", agentId: "hooks" })]),
    {
      method: "POST",
      url: options.mapping ? "/hooks/terminal" : "/hooks/agent",
      headers: {
        authorization: "Bearer hook-secret",
        "content-type": "application/json",
      },
      socket: { remoteAddress: "127.0.0.1" },
    },
  ) as unknown as IncomingMessage;
  let responseBody = "";
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((chunk: string) => {
      responseBody = chunk;
    }),
  } as unknown as ServerResponse;

  if (options.rejectInitialConfig !== false) {
    mocks.getRuntimeConfig.mockImplementationOnce(() => {
      throw new Error("required system config unavailable");
    });
  }
  mocks.getRuntimeConfig.mockReturnValue(config);
  expect(await handler(req, res)).toBe(true);
  return { body: JSON.parse(responseBody) as { runId: string }, status: res.statusCode, logHooks };
}

describe("gateway hook early-failure recovery", () => {
  const logPathTracker = createSuiteLogPathTracker("openclaw-hook-terminal-");

  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetCommandQueueStateForTest();
    applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency({}));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await flushLogger();
    resetGatewayWorkAdmission();
    loggingState.rawConsole = null;
    resetLogger();
    resetCommandQueueStateForTest();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it.each<{
    name: string;
    outcome: RunCronAgentTurnResult;
    level: "info" | "warn";
    deliver: boolean;
    events: number;
    throws?: boolean;
  }>([
    {
      name: "warns with the HTTP runId when admitted execution succeeds but delivery fails",
      outcome: {
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "transport refused delivery",
      },
      level: "warn",
      deliver: true,
      events: 0,
    },
    {
      name: "logs delivered success without another announcement",
      outcome: { status: "ok", delivered: true, deliveryAttempted: true },
      level: "info",
      deliver: true,
      events: 0,
    },
    {
      name: "does not label an attempted delivery without an acknowledgment as failure",
      outcome: { status: "ok", delivered: false, deliveryAttempted: true },
      level: "info",
      deliver: true,
      events: 0,
    },
    {
      name: "records explicit suppression without labeling it a delivery failure",
      outcome: {
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
        deliverySuppressionReason: "silent",
      },
      level: "info",
      deliver: true,
      events: 0,
    },
    {
      name: "leaves missing delivery facts unknown for deliver false",
      outcome: { status: "ok" },
      level: "info",
      deliver: false,
      events: 0,
    },
    {
      name: "keeps the existing fallback announcement when delivery was not attempted",
      outcome: { status: "ok", delivered: false },
      level: "info",
      deliver: true,
      events: 1,
    },
    {
      name: "correlates non-ok execution after HTTP admission",
      outcome: { status: "error", error: "execution failed" },
      level: "warn",
      deliver: false,
      events: 1,
    },
    {
      name: "correlates model-preflight rejection with the HTTP 502 runId",
      outcome: {
        status: "skipped",
        error: "model provider unavailable",
        admissionDisposition: "rejected",
      },
      level: "warn",
      deliver: false,
      events: 1,
    },
    {
      name: "correlates thrown errors without inventing runtime session facts",
      outcome: { status: "error", error: "runner exploded" },
      level: "warn",
      deliver: false,
      events: 1,
      throws: true,
    },
  ])("$name", async (testCase) => {
    const completion = createDeferred();
    const result: RunCronAgentTurnResult = {
      summary: testCase.outcome.status === "ok" ? "private success summary" : undefined,
      outputText: "private output",
      sessionId: "runtime-session-id",
      sessionKey: "agent:main:cron:job:run:runtime-session-id",
      ...testCase.outcome,
    };
    const originalResult = structuredClone(result);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        if (result.status === "skipped") {
          return result;
        }
        params.onExecutionStarted?.();
        await completion.promise;
        if (testCase.throws) {
          throw new Error(result.error);
        }
        return result;
      },
    );
    const response = await postAgentHook(false, {
      rejectInitialConfig: false,
      mapping: {
        match: { path: "terminal" },
        action: "agent",
        name: "Delivery",
        messageTemplate: "{{message}}",
        sessionKey: "hook:terminal",
        deliver: testCase.deliver,
      },
    });
    try {
      if (result.status === "skipped") {
        expect(response.status).toBe(502);
        expect(response.body).toEqual({
          ok: false,
          error: "hook agent run failed before entering the agent runner",
          runId: expect.any(String),
        });
      } else {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true, runId: expect.any(String) });
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(response.logHooks.warn).not.toHaveBeenCalled();
        expect(response.logHooks.info).not.toHaveBeenCalled();
      }
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({
            delivery: testCase.deliver
              ? { mode: "announce", channel: "last", to: undefined }
              : { mode: "none" },
          }),
        }),
      );
    } finally {
      completion.resolve();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    const terminalLog = response.logHooks[testCase.level];
    expect(terminalLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^hook agent run completed /),
      expect.objectContaining({
        runId: response.body.runId,
        jobId: mocks.runCronIsolatedAgentTurn.mock.calls[0]?.[0].job.id,
        sourcePath: "/hooks/terminal",
        name: "Delivery",
        status: result.status,
        agentId: "main",
        logicalSessionKey: "hook:terminal",
        deliver: testCase.deliver,
      }),
    );
    const message = terminalLog.mock.calls[0]?.[0];
    expect(message).toContain(`runId=${response.body.runId}`);
    expect(message).toContain(`status=${result.status}`);
    const meta = terminalLog.mock.calls[0]?.[1] ?? {};
    for (const key of [
      "delivered",
      "deliveryAttempted",
      "deliveryError",
      "deliverySuppressionReason",
      "sessionId",
      "sessionKey",
    ] as const) {
      expect(meta[key]).toBe(testCase.throws ? undefined : result[key]);
    }
    expect(response.logHooks[testCase.level === "warn" ? "info" : "warn"]).not.toHaveBeenCalled();
    expect(JSON.stringify(meta)).not.toMatch(/private success summary|private output|Dispatch/);
    for (const key of ["outputText", "message", "delivery", "to", "accountId", "consoleMessage"]) {
      expect(meta).not.toHaveProperty(key);
    }
    expect(result).toEqual(originalResult);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(testCase.events);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(testCase.events);
  });

  it.each([
    { outcome: "delivery", style: "pretty" },
    { outcome: "error", style: "compact" },
    { outcome: "skipped", style: "json" },
    { outcome: "throw", style: "compact" },
  ] as const)(
    "redacts and bounds $outcome diagnostics for the log reader and $style console sink",
    async ({ outcome, style }) => {
      applyLoggingConfig({
        redactPatterns: [String.raw`PRIVATE\[[^\]]+\]`],
      });
      const logPath = logPathTracker.nextPath();
      setLoggerOverride({
        level: "info",
        file: logPath,
        consoleLevel: "info",
        consoleStyle: style,
      });
      const sink = vi.fn();
      loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
      const customSecret = `PRIVATE[${"x".repeat(550)}]`;
      const diagnostic = `line\nAuthorization: Bearer fake-secret-value\n${customSecret}\u0085tail\tend`;
      const result: RunCronAgentTurnResult = {
        status: outcome === "delivery" ? "ok" : outcome === "skipped" ? "skipped" : "error",
        ...(outcome === "delivery"
          ? { delivered: false, deliveryAttempted: true, deliveryError: diagnostic }
          : { error: diagnostic }),
        ...(outcome === "skipped" ? { admissionDisposition: "rejected" } : {}),
        sessionId: `session\u0000${customSecret}`,
        sessionKey: `agent:main:cron:${customSecret}`,
        model: `${"m".repeat(499)}🦞end`,
        outputText: "private output",
      };
      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void }) => {
          if (outcome !== "skipped") {
            params.onExecutionStarted?.();
          }
          if (outcome === "throw") {
            throw new Error(diagnostic);
          }
          return result;
        },
      );
      const response = await postAgentHook(false, {
        rejectInitialConfig: false,
        logger: createSubsystemLogger("gateway/hooks"),
        mapping: {
          match: { path: "terminal" },
          action: "agent",
          name: `${"n".repeat(480)} ${customSecret}`,
          messageTemplate: "{{message}}",
          sessionKey: "hook:terminal",
          deliver: true,
        },
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(response.status).toBe(outcome === "skipped" ? 502 : 200);
      expect(response.body).toMatchObject({ ok: outcome !== "skipped", runId: expect.any(String) });
      expect(response.logHooks.warn).toHaveBeenCalledOnce();
      const meta = response.logHooks.warn.mock.calls[0]?.[1];
      expect(meta).toBeDefined();
      expect(meta).not.toHaveProperty("consoleMessage");
      await flushLogger();
      const lines = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      const fileLine = lines[0]!;
      const record = JSON.parse(fileLine);
      expect(record["1"]).toEqual(meta);
      expect(record["1"]).toMatchObject({
        runId: response.body.runId,
        status: result.status,
        agentId: "main",
        logicalSessionKey: "hook:terminal",
        [outcome === "delivery" ? "deliveryError" : "summary"]: expect.stringContaining("tail end"),
      });
      expect(record.agent_id).toBe("main");
      expect(record.session_id).toBe(outcome === "throw" ? undefined : meta?.sessionId);
      const parsed = parseLogLine(fileLine);
      expect(parsed).toMatchObject({ level: "warn", subsystem: "gateway/hooks" });
      const message = parsed!.message;
      expect.soft(message).toContain(`runId=${response.body.runId}`);
      expect.soft(message).toContain(`status=${result.status}`);
      expect
        .soft(message)
        .toContain(
          outcome === "delivery"
            ? "deliveryError=line"
            : outcome === "throw"
              ? "summary=Error: line"
              : "summary=line",
        );
      expect.soft(message).toContain("tail end");
      expect(message).toMatch(/^hook agent run completed /);
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(message).not.toMatch(/\p{Surrogate}/u);
      expect(fileLine).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output|Dispatch/);
      for (const value of Object.values(meta ?? {})) {
        if (typeof value !== "string") {
          continue;
        }
        expect(value.length).toBeLessThanOrEqual(500);
        expect(value).not.toMatch(/\p{Surrogate}/u);
        expect(value).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
        expect(value).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output/);
      }
      expect(meta?.[outcome === "delivery" ? "deliveryError" : "summary"]).toContain("tail end");
      expect(meta?.name).toContain("PRIVAT");
      if (outcome !== "throw") {
        expect(meta?.model).toBe("m".repeat(499));
      }
      expect(sink).toHaveBeenCalledOnce();
      const line = String(sink.mock.calls[0]?.[0]);
      expect(response.logHooks.warn.mock.calls[0]?.[0]).toBe(message);
      expect(line).not.toMatch(/fake-secret-value|PRIVATE\[|x{20}|private output/);
      if (style === "json") {
        expect(JSON.parse(line)).toMatchObject({
          level: "warn",
          runId: response.body.runId,
          status: "skipped",
          message,
        });
      } else {
        expect(line).toContain(message);
      }
      const events = outcome === "delivery" ? 0 : 1;
      expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(events);
      expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(events);
    },
  );

  it.each([
    { scope: "agent-scoped", eventSessionKey: "agent:hooks:main" },
    { scope: "global", eventSessionKey: "global" },
  ])("keeps the accepted agent authoritative for $scope recovery", async (testCase) => {
    const global = testCase.scope === "global";
    const response = await postAgentHook(global);

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      ok: false,
      error: "hook agent run failed before entering the agent runner",
      runId: expect.any(String),
    });
    expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "Hook Recovery (error): Error: required system config unavailable",
      { sessionKey: testCase.eventSessionKey },
    );
    const eventOptions = mocks.enqueueSystemEvent.mock.calls[0]?.[1] as object;
    expect(resolveSystemEventOptionsOwnerAgentId(eventOptions)).toBe(global ? "hooks" : null);

    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: expect.stringMatching(/^hook:[0-9a-f-]+:error$/),
      agentId: "hooks",
      ...(global ? {} : { sessionKey: testCase.eventSessionKey }),
    });
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it.each(["startTurn", "runTurn"] as const)(
    "does not invoke ACP %s after the final Gateway admission deadline rejects the prompt",
    async (runtimeApi) => {
      const releasePreparation = createDeferred();
      const handle = {
        sessionKey: "agent:hooks:acp:gateway-admission",
        backend: "test-acp",
        runtimeSessionName: "gateway-admission",
      };
      const startTurn = vi.fn((turn: AcpRuntimeTurnInput) => ({
        requestId: turn.requestId,
        promptStarted: Promise.resolve(),
        events: (async function* () {})(),
        result: Promise.resolve({ status: "completed" as const }),
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      const runTurn = vi.fn((_turn: AcpRuntimeTurnInput) => (async function* () {})());
      const runtime = {
        ensureSession: vi.fn(async () => handle),
        ...(runtimeApi === "startTurn" ? { startTurn } : {}),
        runTurn,
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      } satisfies AcpRuntime;

      mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
        async (params: { onExecutionStarted?: () => void; abortSignal?: AbortSignal }) => {
          await releasePreparation.promise;
          const streamOptions = {
            runtime,
            turn: {
              handle,
              text: "Dispatch",
              mode: "prompt" as const,
              requestId: `gateway-admission-${runtimeApi}`,
              signal: params.abortSignal,
            },
            eventGate: { open: true },
            onBeforePrompt: params.onExecutionStarted,
            onPromptStarted: () => params.onExecutionStarted?.(),
          };
          await consumeAcpTurnStream(streamOptions);
          return { status: "ok", summary: "done" };
        },
      );

      try {
        const response = await postAgentHook(false, {
          admissionTimeoutMs: 10,
          rejectInitialConfig: false,
        });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
          ok: false,
          error: "hook agent run did not start before admission timeout",
        });
      } finally {
        releasePreparation.resolve();
      }

      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledOnce();
      expect(startTurn).not.toHaveBeenCalled();
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false, true])(
    "contains plugin email turns with HTTP hooks enabled=%s",
    async (enabled) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: { default: true }, hooks: {} } },
        hooks: {
          enabled,
          allowedAgentIds: ["main"],
          allowedSessionKeyPrefixes: ["hook:http:"],
        },
      };
      mocks.getRuntimeConfig.mockReturnValue(config);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
      const onStart = queueHookRunner();
      const { dispatcher, logHooks } = createPluginHookDispatcher({ admissionTimeoutMs: 100 });
      const unsafePluginTurn = {
        ...pluginHookTurn,
        allowUnsafeExternalContent: true,
        sessionMode: "persistent",
      };

      const result = await dispatcher.dispatchHookAgentTurn(unsafePluginTurn, "imap");
      // Drain a closed lane after the regression fails; expired admission still fences execution.
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(createConfig(false)));
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      expect(result).toEqual({ ok: true, runId: expect.any(String) });
      expect(onStart).toHaveBeenCalledOnce();
      expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "hooks",
          sessionKey: pluginHookTurn.sessionKey,
          lane: CommandLane.CronNested,
          job: expect.objectContaining({
            name: "IMAP fastmail",
            agentId: "hooks",
            sessionTarget: "isolated",
            payload: expect.objectContaining({
              kind: "agentTurn",
              message: pluginHookTurn.message,
              externalContentSource: "email",
              allowUnsafeExternalContent: undefined,
            }),
            delivery: { mode: "none" },
          }),
          executionIdentity: {
            ingress: {
              kind: "webhook",
              boundary: "gateway.hooks.plugin",
              state: "present",
              rawSourceRef: "imap:IMAP fastmail",
            },
          },
        }),
      );
      await vi.waitFor(() =>
        expect(logHooks.info).toHaveBeenCalledWith(
          expect.stringMatching(/^hook agent run completed /),
          expect.objectContaining({ name: "IMAP fastmail" }),
        ),
      );
    },
  );

  it("announces successful plugin hook turns through the existing heartbeat path", async () => {
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "ok", summary: "New email summarized" };
      },
    );
    const { dispatcher } = createPluginHookDispatcher();

    await expect(
      dispatcher.dispatchHookAgentTurn({ ...pluginHookTurn, deliver: true }, "imap"),
    ).resolves.toEqual({ ok: true, runId: expect.any(String) });

    await vi.waitFor(() =>
      expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
        "Hook IMAP fastmail: New email summarized",
        { sessionKey: "agent:hooks:main" },
      ),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: expect.stringMatching(/^hook:[0-9a-f-]+$/),
      agentId: "hooks",
      sessionKey: "agent:hooks:main",
    });
  });

  it("reports plugin hook execution errors through the existing failure path", async () => {
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockRejectedValueOnce(new Error("runner preparation failed"));
    const { dispatcher, logHooks } = createPluginHookDispatcher();

    await expect(dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap")).resolves.toEqual({
      ok: false,
      reason: "hook agent run failed before entering the agent runner",
    });

    expect(logHooks.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^hook agent run completed /),
      expect.objectContaining({ status: "error", summary: "Error: runner preparation failed" }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      "Hook IMAP fastmail (error): Error: runner preparation failed",
      { sessionKey: "agent:hooks:main" },
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: expect.stringMatching(/^hook:[0-9a-f-]+:error$/),
      agentId: "hooks",
      sessionKey: "agent:hooks:main",
    });
  });

  it.each([
    { name: "missing agent ownership", override: { agentId: "  " }, reason: "agentId is required" },
    { name: "non-hook session", override: { sessionKey: "agent:hooks:main" } },
    { name: "empty hook session", override: { sessionKey: "hook:" } },
    { name: "session whitespace", override: { sessionKey: "hook:imap:bad value" } },
    { name: "trimmed session whitespace", override: { sessionKey: " hook:imap:message" } },
    { name: "session control character", override: { sessionKey: "hook:imap:\u0000message" } },
    {
      name: "non-email content",
      override: { externalContentSource: "webhook" as "email" },
      reason: "externalContentSource must be email",
    },
  ])("rejects plugin hook turns with $name before dispatch", async ({ override, reason }) => {
    const { dispatcher } = createPluginHookDispatcher();

    await expect(
      dispatcher.dispatchHookAgentTurn({ ...pluginHookTurn, ...override }, "imap"),
    ).resolves.toEqual({
      ok: false,
      reason:
        reason ??
        "sessionKey must start with hook: and contain no whitespace or control characters",
    });
    expect(mocks.runCronIsolatedAgentTurn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "session conflict",
      result: {
        status: "error",
        error: "session changed",
        admissionDisposition: "session-conflict",
      },
      reason: "hook agent run was rejected because the target session changed",
    },
    {
      name: "preparation failure",
      result: { status: "error", error: "provider preparation failed" },
      reason: "hook agent run failed before entering the agent runner",
    },
  ])("preserves plugin hook $name admission failure taxonomy", async ({ result, reason }) => {
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockResolvedValueOnce(result);
    const { dispatcher } = createPluginHookDispatcher();

    await expect(dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap")).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it.each([false, true])(
    "bounds plugin work by cron capacity and fences expired admission=%s",
    async (expire) => {
      const config = { agents: createConfig(false).agents };
      mocks.getRuntimeConfig.mockReturnValue(config);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
      const releaseCron = createDeferred();
      const cronRuns = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () =>
        enqueueCommandInLane(CommandLane.CronNested, async () => await releaseCron.promise),
      );
      const onStart = queueHookRunner();
      const { dispatcher } = createPluginHookDispatcher({
        admissionTimeoutMs: expire ? 100 : 5_000,
      });
      const admission = dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap");

      try {
        await vi.waitFor(() =>
          expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
            activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
            queuedCount: 1,
          }),
        );
        expect(onStart).not.toHaveBeenCalled();
        if (!expire) {
          releaseCron.resolve();
        }
        await expect(admission).resolves.toEqual(
          expire
            ? {
                ok: false,
                reason: "hook agent run did not start before admission timeout",
              }
            : { ok: true, runId: expect.any(String) },
        );
      } finally {
        releaseCron.resolve();
        applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(createConfig(false)));
        await Promise.all(cronRuns);
        await admission;
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
      expect(onStart).toHaveBeenCalledTimes(expire ? 0 : 1);
      expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
      });
    },
  );

  it("serializes HTTP and plugin turns together while replaying plugin idempotency keys", async () => {
    const releaseHttpRun = createDeferred();
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        await releaseHttpRun.promise;
        return { status: "ok", summary: "HTTP done" };
      })
      .mockImplementationOnce(async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "ok", summary: "plugin done" };
      });
    const { dispatcher } = createPluginHookDispatcher();
    const httpResult = await dispatcher.dispatchAgentHook({
      ...pluginHookTurn,
      effectiveAgentId: "hooks",
      sessionMode: "isolated",
      sourcePath: "/hooks/gmail",
      wakeMode: "now",
      channel: "last",
      delivery: { mode: "none" },
      externalContentSource: "gmail",
    });
    expect(httpResult.ok).toBe(true);

    const pluginTurn = { ...pluginHookTurn, idempotencyKey: "message-42" };
    const firstPluginRun = dispatcher.dispatchHookAgentTurn(pluginTurn, "imap");
    const duplicatePluginRun = dispatcher.dispatchHookAgentTurn(pluginTurn, "imap");
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledOnce();

    releaseHttpRun.resolve();
    const [first, duplicate] = await Promise.all([firstPluginRun, duplicatePluginRun]);
    expect(first).toEqual({ ok: true, runId: expect.any(String) });
    expect(duplicate).toEqual(first);
    await expect(dispatcher.dispatchHookAgentTurn(pluginTurn, "imap")).resolves.toEqual(first);
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledTimes(2);
  });
});
