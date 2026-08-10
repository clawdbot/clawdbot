import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Split out of http-handler.test.ts to keep both files under the `max-lines`
// cap. These two suites cover the request-shaping surfaces — what the handler
// forwards into the agent prompt, and how it admits or refuses a device —
// neither of which touches the SSE stream lifecycle the main file exercises.

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@ag-ui/encoder", () => ({
  // Regular (constructable) function — production does `new EventEncoder(...)`,
  // and this vitest version cannot `new` a mock whose implementation is an
  // arrow function (arrows have no [[Construct]]).
  EventEncoder: vi.fn().mockImplementation(function () {
    return {
      getContentType: () => "text/event-stream",
      encode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
    };
  }),
}));

// The handler ensures a SQLite session entry exists before runEmbeddedAgent.
// Mock the session store so unit tests don't touch a real store; getSessionEntry
// returns undefined (cold turn -> upsert runs, then no-op).
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(() => undefined),
  upsertSessionEntry: vi.fn(async () => {}),
}));

import { createAguiHttpHandler } from "./http-handler.js";
import {
  createReq,
  createRes,
  parseEvents,
  createDeviceToken,
  createFakeApi,
  GATEWAY_SECRET,
  APPROVED_DEVICE_ID,
} from "./http-handler.test-helpers.js";

// ---------------------------------------------------------------------------
// AG-UI context forwarding
// ---------------------------------------------------------------------------

describe("AG-UI RunAgentInput.context forwarding", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
  });

  // Context is no longer injected via finalizeInboundContext's BodyForAgent;
  // the handler now appends formatContextEntries(...) to the `prompt` passed to
  // runEmbeddedAgent (via promptSuffix). These tests assert the equivalent
  // behavior on that prompt.
  it("includes context entries in the run prompt", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx",
        runId: "r-ctx",
        messages: [{ role: "user", content: "Approve writes" }],
        context: [
          {
            description: "Pending tool-call approvals",
            value: '[{"callId":"write_123","toolName":"write"}]',
          },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).toContain("## Context provided by the UI");
    expect(call.prompt).toContain("### Pending tool-call approvals");
    expect(call.prompt).toContain("write_123");
  });

  it("does not inject a context block into the prompt when context is empty", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-empty",
        runId: "r-ctx-empty",
        messages: [{ role: "user", content: "Hello" }],
        context: [],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
  });

  it("filters out context entries with empty description and value", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-filter",
        runId: "r-ctx-filter",
        messages: [{ role: "user", content: "Hello" }],
        context: [
          { description: "", value: "" },
          { description: "App state", value: "editing" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).toContain("### App state");
    expect(call.prompt).toContain("editing");
    // Should not have an empty heading
    expect(call.prompt).not.toContain("### \n");
  });

  it("does not inject a context block into the prompt when all context entries are empty", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-all-empty",
        runId: "r-ctx-all-empty",
        messages: [{ role: "user", content: "Hello" }],
        context: [
          { description: "", value: "" },
          { description: "", value: "" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
  });

  it("does not inject a context block into the prompt when context is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-none",
        runId: "r-ctx-none",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
  });
});

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

describe("CORS preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
  });

  // The pairing route is `auth: "plugin"`, so core lets an unauthenticated
  // OPTIONS reach this handler and the browser gets its 204 + CORS headers.
  //
  // The operator route is `auth: "gateway"` and core rejects an unauthenticated
  // OPTIONS before any plugin handler runs, so its preflight branch is dead —
  // verified live: `OPTIONS /v1/ag-ui/operator` answers 401 with no CORS headers
  // while `OPTIONS /v1/ag-ui` answers 204 with them. That is why the operator
  // route is documented for server-side callers, which send no preflight; this
  // test pins the browser-reachable route so the distinction is not lost.
  it("answers the pairing route's preflight with 204 and the headers a browser needs", async () => {
    const fakeApi = createFakeApi([]);
    const handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
    const req = createReq({
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3119",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
    // Sending an AG-UI run needs these two custom headers, so a preflight that
    // omitted them would let the browser block every real request.
    expect(res.headers["access-control-allow-headers"]).toContain("x-openclaw-agent-id");
    expect(res.headers["access-control-allow-headers"]).toContain("x-openclaw-session-key");
  });
});

// ---------------------------------------------------------------------------
// Device Pairing Tests
// ---------------------------------------------------------------------------

describe("Device pairing", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
  });

  it("returns pairing_pending with pairingCode and token when no auth header", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.pairing.pairingCode).toBe("TEST1234");
    expect(body.error.pairing.token).toBeDefined();
    expect(body.error.pairing.instructions).toContain("openclaw pairing approve ag-ui");
  });

  it("calls upsertPairingRequest when initiating pairing", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
      }),
    );
  });

  it("rejects invalid HMAC signature with 401", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    // Token with invalid signature
    const req = createReq({
      headers: { authorization: "Bearer aW52YWxpZC1kZXZpY2UtaWQ.invalidsignature" },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns pairing_pending for valid token but unapproved device", async () => {
    // No approved devices
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    // Create valid HMAC token for a device that's not approved
    const unapprovedDeviceId = "87654321-4321-4321-4321-abcdef123456";
    const token = createDeviceToken(GATEWAY_SECRET, unapprovedDeviceId);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.message).toContain("pending approval");
  });

  it("proceeds normally for valid token with approved device", async () => {
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "Hello" }] },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("returns 429 rate_limit when max pending pairing requests reached", async () => {
    // Simulate rate limit by returning empty code
    fakeApi = createFakeApi([], { pairingCode: "" });
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header - initiates pairing
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("rate_limit");
    expect(body.error.message).toContain("Too many pending pairing requests");
  });
});
