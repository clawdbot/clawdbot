import type { SetSessionModeRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

function createSetSessionModeRequest(modeId: string): SetSessionModeRequest {
  return {
    sessionId: "session-1",
    modeId,
  } as unknown as SetSessionModeRequest;
}

function createAgentWithSession(request: GatewayClient["request"]) {
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    cwd: "/tmp",
  });
  return new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
    sessionStore,
  });
}

function createRequestRecorder(
  handler: (...args: Parameters<GatewayClient["request"]>) => Promise<unknown>,
) {
  const calls: Parameters<GatewayClient["request"]>[] = [];
  const request = (async (...args: Parameters<GatewayClient["request"]>) => {
    calls.push(args);
    return handler(...args);
  }) as GatewayClient["request"];
  return { calls, request };
}

describe("acp setSessionMode", () => {
  it("setSessionMode propagates gateway error", async () => {
    const { calls, request } = createRequestRecorder(async () => {
      throw new Error("gateway rejected mode change");
    });
    const agent = createAgentWithSession(request);

    await expect(agent.setSessionMode(createSetSessionModeRequest("high"))).rejects.toThrow(
      "gateway rejected mode change",
    );
    expect(calls).toStrictEqual([
      [
        "sessions.patch",
        {
          key: "agent:main:main",
          thinkingLevel: "high",
        },
      ],
    ]);
  });

  it("setSessionMode succeeds when gateway accepts", async () => {
    const { calls, request } = createRequestRecorder(async () => ({ ok: true }));
    const agent = createAgentWithSession(request);

    await expect(agent.setSessionMode(createSetSessionModeRequest("low"))).resolves.toStrictEqual(
      {},
    );
    expect(calls).toStrictEqual([
      [
        "sessions.patch",
        {
          key: "agent:main:main",
          thinkingLevel: "low",
        },
      ],
      [
        "sessions.list",
        {
          includeDerivedTitles: true,
          limit: 200,
          search: "agent:main:main",
        },
      ],
    ]);
  });

  it("setSessionMode returns early for empty modeId", async () => {
    const { calls, request } = createRequestRecorder(async () => ({ ok: true }));
    const agent = createAgentWithSession(request);

    await expect(agent.setSessionMode(createSetSessionModeRequest(""))).resolves.toStrictEqual({});
    expect(calls).toStrictEqual([]);
  });
});
