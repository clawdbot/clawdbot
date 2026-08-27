import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AcpRuntime, AcpRuntimeTurnInput } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { consumeAcpTurnStream } from "../../acp/control-plane/manager.turn-stream.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSystemEventOptionsOwnerAgentId } from "../../infra/system-event-ownership.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveHooksConfig } from "../hooks.js";

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

function createConfig(global: boolean): OpenClawConfig {
  return {
    agents: { entries: { main: { default: true }, hooks: {} } },
    hooks: { enabled: true, token: "hook-secret" },
    ...(global ? { session: { scope: "global" } } : {}),
  };
}

async function postAgentHook(
  global: boolean,
  options: { admissionTimeoutMs?: number; rejectInitialConfig?: boolean } = {},
) {
  const config = createConfig(global);
  const hooksConfig = resolveHooksConfig(config);
  if (!hooksConfig) {
    throw new Error("expected resolved hooks config");
  }
  const handler = createGatewayHooksRequestHandler({
    deps: {} as never,
    getHooksConfig: () => hooksConfig,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    agentStartAdmissionTimeoutMs: options.admissionTimeoutMs,
  });
  const req = Object.assign(
    Readable.from([JSON.stringify({ message: "Dispatch", name: "Recovery", agentId: "hooks" })]),
    {
      method: "POST",
      url: "/hooks/agent",
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
  return { body: JSON.parse(responseBody) as unknown, status: res.statusCode };
}

describe("gateway hook early-failure recovery", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

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

  it("contains plugin email turns without enabling the HTTP hook surface", async () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true }, hooks: {} } },
      hooks: {
        allowedAgentIds: ["main"],
        allowedSessionKeyPrefixes: ["hook:http:"],
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(
      async (params: { onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      },
    );
    const { dispatcher, logHooks } = createPluginHookDispatcher();
    const unsafePluginTurn = {
      ...pluginHookTurn,
      allowUnsafeExternalContent: true,
      sessionMode: "persistent",
    };

    const result = await dispatcher.dispatchHookAgentTurn(unsafePluginTurn, "imap");

    expect(result).toEqual({ ok: true, runId: expect.any(String) });
    expect(mocks.runCronIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "hooks",
        sessionKey: pluginHookTurn.sessionKey,
        lane: CommandLane.HookDispatch,
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
        "hook agent run completed without announcement",
        expect.objectContaining({ name: "IMAP fastmail" }),
      ),
    );
  });

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
      "hook agent failed: Error: runner preparation failed",
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

  it("preserves plugin hook admission timeout and fences late execution", async () => {
    const releasePreparation = createDeferred();
    mocks.getRuntimeConfig.mockReturnValue(createConfig(false));
    mocks.runCronIsolatedAgentTurn.mockImplementationOnce(async () => {
      await releasePreparation.promise;
      return { status: "ok", summary: "done" };
    });
    const { dispatcher } = createPluginHookDispatcher({ admissionTimeoutMs: 10 });

    try {
      await expect(dispatcher.dispatchHookAgentTurn(pluginHookTurn, "imap")).resolves.toEqual({
        ok: false,
        reason: "hook agent run did not start before admission timeout",
      });
    } finally {
      releasePreparation.resolve();
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

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
