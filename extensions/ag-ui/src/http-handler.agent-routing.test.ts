import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Who may choose the agent, and what happens when they may not.
//
// `X-OpenClaw-Agent-Id` is honoured ONLY on the gateway-authenticated operator
// route. A paired device is untrusted: its agent comes from its peer/channel
// binding, so accepting the header there would let a device bound to one agent
// run another agent's workspace, tools, and credentials.

vi.mock("@ag-ui/encoder", () => ({
  EventEncoder: vi.fn().mockImplementation(function () {
    return {
      getContentType: () => "text/event-stream",
      encode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
    };
  }),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(() => undefined),
  upsertSessionEntry: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  listAgentIds: vi.fn(() => ["main", "auditor"]),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  deriveLastRoutePolicy: vi.fn(({ sessionKey, mainSessionKey }) =>
    sessionKey === mainSessionKey ? "main" : "session",
  ),
}));

import { createAguiHttpHandler, createOperatorAguiHttpHandler } from "./http-handler.js";
import {
  createReq,
  createRes,
  parseEvents,
  createDeviceToken,
  createFakeApi,
  GATEWAY_SECRET,
  APPROVED_DEVICE_ID,
} from "./http-handler.test-helpers.js";

function body(threadId: string) {
  return {
    threadId,
    runId: `run-${threadId}`,
    messages: [{ role: "user", content: "Hello" }],
  };
}

describe("agent selection is scoped to the trusted route", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let paired: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  let operator: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    // The route a binding would select for this paired device.
    fakeApi.runtime.channel.routing.resolveAgentRoute.mockReturnValue({
      sessionKey: "agui:bound-session",
      mainSessionKey: "agui:bound-session",
      agentId: "main",
      accountId: "default",
      lastRoutePolicy: "main",
      matchedBy: "binding.peer",
    });
    fakeApi.runtime.channel.routing.buildAgentSessionKey = vi.fn(
      (p: { agentId: string }) => `agui:${p.agentId}:rebuilt`,
    );
    paired = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
    operator = createOperatorAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
  });

  function pairedReq(threadId: string, agentId?: string) {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    return createReq({
      headers: {
        authorization: `Bearer ${token}`,
        ...(agentId ? { "x-openclaw-agent-id": agentId } : {}),
      },
      body: body(threadId),
    });
  }

  // The binding-isolation regression: `auditor` IS a configured agent, so this
  // is not the unknown-name case — it is a valid name the paired device must
  // still not be able to select.
  it("refuses a paired device that asks for another configured agent", async () => {
    const res = createRes();
    await paired(pairedReq("t-bind", "auditor"), res);

    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(res.chunks.join(""));
    expect(payload.error.type).toBe("invalid_request_error");
    expect(payload.error.message).toContain("X-OpenClaw-Agent-Id");
    // The run must not start, and nothing may route to the requested agent.
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(parseEvents(res.chunks)).toHaveLength(0);
    for (const call of fakeApi.runtime.channel.routing.buildAgentSessionKey.mock.calls) {
      expect(call[0]?.agentId).not.toBe("auditor");
    }
  });

  it("refuses a paired device naming even its own bound agent", async () => {
    // The header is not a hint on this route; the binding is the only input.
    const res = createRes();
    await paired(pairedReq("t-bind-self", "main"), res);

    expect(res.statusCode).toBe(400);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("refuses the header on an empty init/sync request too", async () => {
    // The empty-messages path returns a 200 empty run early. If the refusal sat
    // after it, the rule would hold on turns that run an agent but not on
    // session init — the header would be accepted on some paths and not others.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await paired(
      createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-agent-id": "auditor",
        },
        body: { threadId: "t-init", runId: "r-init", messages: [] },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(parseEvents(res.chunks)).toHaveLength(0);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("runs a paired device on its bound agent when it sends no header", async () => {
    const res = createRes();
    await paired(pairedReq("t-bind-none"), res);

    expect(res.statusCode).toBe(200);
    const call = fakeApi.runtime.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.agentId).toBe("main");
    expect(call.sessionKey).toContain("agui:bound-session");
  });

  it("lets the operator route select a configured agent", async () => {
    const res = createRes();
    await operator(
      createReq({ headers: { "x-openclaw-agent-id": "auditor" }, body: body("t-op") }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const call = fakeApi.runtime.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.agentId).toBe("auditor");
  });

  it("rejects an unknown agent on the operator route instead of using the default", async () => {
    const res = createRes();
    await operator(
      createReq({ headers: { "x-openclaw-agent-id": "no-such-agent" }, body: body("t-op-bad") }),
      res,
    );

    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(res.chunks.join(""));
    expect(payload.error.message).toContain("X-OpenClaw-Agent-Id");
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("never forwards the agent header as accountId", async () => {
    // accountId feeds channel-account bindings only; passing the agent name
    // there is what made an unmatched name fall through to the default agent.
    await operator(
      createReq({ headers: { "x-openclaw-agent-id": "auditor" }, body: body("t-op-acct") }),
      createRes(),
    );

    for (const call of fakeApi.runtime.channel.routing.resolveAgentRoute.mock.calls) {
      expect(call[0]?.accountId).toBeUndefined();
    }
  });
});
