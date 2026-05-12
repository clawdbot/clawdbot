import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChannelTurnContextMock,
  dispatchReplyWithBufferedBlockDispatcher,
  finalizeInboundContextMock,
  registerPluginHttpRouteMock,
  resolveAgentRouteMock,
  setSynologyRuntimeConfigForTest,
} from "./channel.test-mocks.js";
import { makeFormBody, makeReq, makeRes } from "./test-http-utils.js";

type _RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

let createSynologyChatPlugin: typeof import("./channel.js").createSynologyChatPlugin;

function makeStartContext<T>(cfg: T, accountId: string, abortSignal: AbortSignal) {
  setSynologyRuntimeConfigForTest(cfg);
  return {
    cfg,
    accountId,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    abortSignal,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  index: number,
  label: string,
): TArgs {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

describe("Synology channel wiring integration", () => {
  beforeAll(async () => {
    ({ createSynologyChatPlugin } = await import("./channel.js"));
  });

  beforeEach(() => {
    registerPluginHttpRouteMock.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    buildChannelTurnContextMock.mockClear();
    finalizeInboundContextMock.mockClear();
    resolveAgentRouteMock.mockClear();
    setSynologyRuntimeConfigForTest({});
  });

  it("registers real webhook handler with resolved account config and enforces allowlist", async () => {
    const plugin = createSynologyChatPlugin();
    const abortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alerts: {
              enabled: true,
              token: "valid-token",
              incomingUrl: "https://nas.example.com/incoming",
              webhookPath: "/webhook/synology-alerts",
              dmPolicy: "allowlist",
              allowedUserIds: ["456"],
            },
          },
        },
      },
    };

    const started = plugin.gateway.startAccount(
      makeStartContext(cfg, "alerts", abortController.signal),
    );
    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(1);

    const firstCall = registerPluginHttpRouteMock.mock.calls.at(0);
    if (!firstCall) {
      throw new Error("Expected registerPluginHttpRoute to be called");
    }
    const registered = firstCall[0];
    expect(registered.path).toBe("/webhook/synology-alerts");
    expect(registered.accountId).toBe("alerts");

    const req = makeReq(
      "POST",
      makeFormBody({
        token: "valid-token",
        user_id: "123",
        username: "unauthorized-user",
        text: "Hello",
      }),
    );
    const res = makeRes();
    await registered.handler(req, res);

    expect(res._status).toBe(403);
    expect(res._body).toContain("not authorized");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    abortController.abort();
    await started;
  });

  it("isolates same user_id across different accounts", async () => {
    const plugin = createSynologyChatPlugin();
    const alphaAbortController = new AbortController();
    const betaAbortController = new AbortController();
    const cfg = {
      channels: {
        "synology-chat": {
          enabled: true,
          accounts: {
            alpha: {
              enabled: true,
              token: "token-alpha",
              incomingUrl: "https://nas.example.com/incoming-alpha",
              webhookPath: "/webhook/synology-alpha",
              dmPolicy: "open",
              allowedUserIds: ["*"],
            },
            beta: {
              enabled: true,
              token: "token-beta",
              incomingUrl: "https://nas.example.com/incoming-beta",
              webhookPath: "/webhook/synology-beta",
              dmPolicy: "open",
              allowedUserIds: ["*"],
            },
          },
        },
      },
      session: {
        dmScope: "main" as const,
      },
    };

    const alphaStarted = plugin.gateway.startAccount(
      makeStartContext(cfg, "alpha", alphaAbortController.signal),
    );
    const betaStarted = plugin.gateway.startAccount(
      makeStartContext(cfg, "beta", betaAbortController.signal),
    );

    expect(registerPluginHttpRouteMock).toHaveBeenCalledTimes(2);
    const [alphaRoute] = requireMockCall(registerPluginHttpRouteMock, 0, "alpha Synology route");
    const [betaRoute] = requireMockCall(registerPluginHttpRouteMock, 1, "beta Synology route");

    const alphaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-alpha",
        user_id: "123",
        username: "alice",
        text: "alpha secret",
      }),
    );
    const alphaRes = makeRes();
    await alphaRoute.handler(alphaReq, alphaRes);

    const betaReq = makeReq(
      "POST",
      makeFormBody({
        token: "token-beta",
        user_id: "123",
        username: "bob",
        text: "beta secret",
      }),
    );
    const betaRes = makeRes();
    await betaRoute.handler(betaReq, betaRes);

    expect(alphaRes._status).toBe(204);
    expect(betaRes._status).toBe(204);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    expect(finalizeInboundContextMock).toHaveBeenCalledTimes(2);

    const [alphaCtx] = requireMockCall(finalizeInboundContextMock, 0, "alpha inbound context");
    const [betaCtx] = requireMockCall(finalizeInboundContextMock, 1, "beta inbound context");
    const alphaContext = requireRecord(alphaCtx, "alpha inbound context");
    expect(alphaContext.AccountId).toBe("alpha");
    expect(alphaContext.SessionKey).toBe("agent:agent-alpha:synology-chat:alpha:direct:123");
    const betaContext = requireRecord(betaCtx, "beta inbound context");
    expect(betaContext.AccountId).toBe("beta");
    expect(betaContext.SessionKey).toBe("agent:agent-beta:synology-chat:beta:direct:123");

    alphaAbortController.abort();
    betaAbortController.abort();
    await alphaStarted;
    await betaStarted;
  });
});
