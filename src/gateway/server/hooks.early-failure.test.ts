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

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

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
});
