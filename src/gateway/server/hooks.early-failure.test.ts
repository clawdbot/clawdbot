import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function postAgentHook(global: boolean) {
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

  mocks.getRuntimeConfig
    .mockImplementationOnce(() => {
      throw new Error("required system config unavailable");
    })
    .mockReturnValue(config);
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
});
