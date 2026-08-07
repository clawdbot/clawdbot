import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@ag-ui/encoder", () => ({
  // Regular (constructable) function — production does `new EventEncoder(...)`,
  // and this vitest version cannot `new` a mock whose implementation is an
  // arrow function (arrows have no [[Construct]]).
  //
  // This mirrors the REAL encoder's asymmetry: getContentType() advertises the
  // protobuf media type when Accept prefers it, while encode() always returns
  // SSE text (only encodeBinary() emits protobuf). Modelling that is what makes
  // a "protobuf content-type on an SSE body" mismatch catchable here; a mock
  // that hardcoded text/event-stream would pass no matter what we sent.
  EventEncoder: vi.fn().mockImplementation(function (params?: { accept?: string }) {
    const acceptsProtobuf = Boolean(params?.accept?.includes("application/vnd.ag-ui.event+proto"));
    return {
      getContentType: () =>
        acceptsProtobuf ? "application/vnd.ag-ui.event+proto" : "text/event-stream",
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
// Tests
// ---------------------------------------------------------------------------

describe("AG-UI HTTP handler", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set env token before handler creation so the factory can resolve it
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    // Create fake API with the approved device
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
  });

  it("rejects non-POST with 405", async () => {
    const req = createReq({ method: "GET" });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects invalid bearer token with 401", async () => {
    const req = createReq({
      headers: { authorization: "Bearer invalid.token" },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("refuses a system-only submission on the paired route", async () => {
    // system/developer messages become extraSystemPrompt, i.e. authority over
    // the agent's instructions, which an untrusted paired caller may not supply.
    // See http-handler.agent-routing.test.ts for the full trust split.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "system", content: "sys" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(parseEvents(res.chunks)).toHaveLength(0);
  });

  it("returns empty run for empty messages array (AG-UI session init)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-empty",
        runId: "r-empty",
        messages: [],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const events = parseEvents(res.chunks);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(events[0]!.threadId).toBe("t-empty");
    expect(events[0]!.runId).toBe("r-empty");
  });

  it("accepts tool-only messages (tool result submission)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-tool-only",
        runId: "r-tool-only",
        messages: [{ role: "tool", toolCallId: "tc-1", content: "72°F sunny" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow
    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("emits RUN_STARTED as first SSE event", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events[0]?.threadId).toBe("t1");
    expect(events[0]?.runId).toBe("r1");
  });

  it("emits RUN_FINISHED after dispatch completes", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res.ended).toBe(true);
  });

  it("calls runEmbeddedAgent with correct sessionKey and runId", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:t1");
    expect(call.runId).toBe("r1");
  });

  it("sends TEXT_MESSAGE events when runEmbeddedAgent streams via onPartialReply", async () => {
    // The handler forwards onPartialReply snapshots as TEXT_MESSAGE_CONTENT
    // deltas. A single cumulative snapshot of "Hello from agent" (from an empty
    // start) yields exactly that text as the delta.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "Hello from agent" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const contentEvt = events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contentEvt?.delta).toBe("Hello from agent");
  });

  it("emits INCREMENTAL reasoning deltas from OpenClaw's cumulative snapshots", async () => {
    // OpenClaw delivers reasoning as a running snapshot (each callback carries
    // the FULL thinking-so-far — see btw.ts `reasoningText += delta`). The
    // adapter must forward only the newly-appended suffix, otherwise the
    // frontend stacks every snapshot into an exploding wall of repeated text.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onReasoningStream({ text: "**Writing**\n\nThe" });
      params.onReasoningStream({ text: "**Writing**\n\nThe user" });
      params.onReasoningStream({ text: "**Writing**\n\nThe user wants" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Write a sonnet" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const deltas = events
      .filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((e) => e.delta);

    // Each delta is ONLY the new suffix, not the full cumulative snapshot.
    expect(deltas).toEqual(["**Writing**\n\nThe", " user", " wants"]);
    // Concatenating the deltas reconstructs the reasoning exactly once — no
    // stacking, no repeated "**Writing**" title.
    expect(deltas.join("")).toBe("**Writing**\n\nThe user wants");
  });

  it("backend-tool run completes and streams to completion (tool events come from hooks)", async () => {
    // Backend/server-side tool calls no longer flow through a dispatcher —
    // they execute in-loop and render via the before_tool_call /
    // tool_result_persist hooks. From the handler's perspective the run simply
    // streams its final assistant text and finishes.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "done" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res.ended).toBe(true);
  });

  it("emits RUN_ERROR on run failure", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockRejectedValue(new Error("agent failed"));

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    const errEvt = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(errEvt?.message).toContain("agent failed");
    expect(res.ended).toBe(true);
  });

  it("suppresses text output when client tool was called", async () => {
    const { setClientToolCalled } = await import("./tool-store.js");

    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Simulate a client tool being called (flag set by before_tool_call hook)
      setClientToolCalled(params.sessionKey);
      // Agent tries to stream text after the tool call — handlePartialReply must
      // suppress it because a client tool was already invoked.
      params.onPartialReply({ text: "unwanted text" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ct",
        runId: "r-ct",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ name: "get_weather", description: "Get weather" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    // Should NOT contain text message events
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    // Should still finish the run
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("keeps tool calls and text in a single run (no run splitting)", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Tool call followed by text — should stay in the same run
      params.onPartialReply({ text: "Here is the result" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-single",
        runId: "r-single",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);

    // Exactly one RUN_STARTED and one RUN_FINISHED — no splitting
    const runStarted = events.filter((e) => e.type === EventType.RUN_STARTED);
    const runFinished = events.filter((e) => e.type === EventType.RUN_FINISHED);
    expect(runStarted.length).toBe(1);
    expect(runFinished.length).toBe(1);
    expect(runStarted[0]?.runId).toBe("r-single");
    expect(runFinished[0]?.runId).toBe("r-single");

    // Text events are present in the same run
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_START);
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_END);
  });

  // -------------------------------------------------------------------------
  // Reasoning events
  // -------------------------------------------------------------------------

  it("emits REASONING events when onReasoningStream/onReasoningEnd are invoked", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Simulate reasoning stream the way OpenClaw's embedded run actually does
      // (embedded-agent-subscribe.ts): a CUMULATIVE `text` snapshot plus the
      // incremental `delta` it already computed. The adapter forwards `delta`.
      // The text message must open lazily on the first text delta (AFTER
      // reasoning), so the reasoning panel renders above the answer.
      params.onReasoningStream({
        text: "Let me think...",
        delta: "Let me think...",
      });
      params.onReasoningStream({
        text: "Let me think...The answer is 42.",
        delta: "The answer is 42.",
      });
      params.onReasoningEnd();
      // Then final text
      params.onPartialReply({ text: "The answer is 42." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-reason",
        runId: "r-reason",
        messages: [{ role: "user", content: "Think carefully" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);

    // Reasoning events should appear
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);

    // Reasoning message start should have role: "reasoning"
    const reasonStart = events.find((e) => e.type === EventType.REASONING_MESSAGE_START);
    expect(reasonStart?.role).toBe("reasoning");

    // Two content deltas
    const reasonContent = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT);
    expect(reasonContent).toHaveLength(2);
    expect(reasonContent[0]?.delta).toBe("Let me think...");
    expect(reasonContent[1]?.delta).toBe("The answer is 42.");

    // All reasoning events share the same messageId
    const reasoningEvents = events.filter(
      (e) => typeof e.type === "string" && (e.type as string).startsWith("REASONING_"),
    );
    const messageIds = new Set(reasoningEvents.map((e) => e.messageId));
    expect(messageIds.size).toBe(1);

    // Reasoning messageId differs from text messageId
    const textStart = events.find((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(textStart?.messageId).not.toBe(reasoningEvents[0]?.messageId);

    // Text message still present after reasoning
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.RUN_FINISHED);

    // Reasoning must be announced BEFORE the answer text so an AG-UI client renders the
    // reasoning panel ABOVE the answer. Regression guard: an eager assistant-message
    // -start hook once opened the text message at turn start (before reasoning),
    // which pushed the reasoning panel to the bottom of the message.
    expect(types.indexOf(EventType.REASONING_START)).toBeLessThan(
      types.indexOf(EventType.TEXT_MESSAGE_START),
    );
  });

  it("does not emit REASONING events when no reasoning stream fires", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "Just text." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-noreason",
        runId: "r-noreason",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);

    expect(types).not.toContain(EventType.REASONING_START);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_START);
  });

  it("auto-closes reasoning if final text fires before onReasoningEnd", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onReasoningStream({ text: "Thinking..." });
      // No onReasoningEnd call — the first text delta (closeReasoningIfOpen in
      // handlePartialReply) and run close should close the reasoning block.
      params.onPartialReply({ text: "Done." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-autoclose",
        runId: "r-autoclose",
        messages: [{ role: "user", content: "Think" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);

    // Reasoning should be properly closed even without explicit onReasoningEnd
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("includes tool messages in conversation context for new run", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-resume",
        runId: "r-resume",
        messages: [
          { role: "user", content: "Weather in Tokyo?" },
          { role: "tool", toolCallId: "tc-1", content: "72°F sunny" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow (has user message + tool context)
    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // `X-OpenClaw-Agent-Id` names the agent that runs the turn. It must never be
  // forwarded as `accountId` — that only feeds channel-account bindings, so an
  // unmatched name would execute on the DEFAULT agent and its workspace instead
  // of failing. An unknown agent is therefore rejected, not downgraded.

  it("routes to the default agent when X-OpenClaw-Agent-Id is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-no-agent",
        runId: "r-no-agent",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "ag-ui" }),
    );
    for (const call of rt.channel.routing.resolveAgentRoute.mock.calls) {
      expect(call[0]?.accountId).toBeUndefined();
    }
  });

  it("uses deviceId as peer ID for identity linking", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-peer",
        runId: "r-peer",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
        peer: { kind: "direct", id: APPROVED_DEVICE_ID },
      }),
    );
  });

  it("appends thread suffix to session key for thread separation", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "My-Thread-42",
        runId: "r-thread",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:my-thread-42");
  });

  it("uses base session key when threadId is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        runId: "r-no-thread",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    // threadId defaults to "ag-ui-<uuid>" so it will have a thread suffix
    expect(call.sessionKey).toMatch(/^agui:test-session:thread:ag-ui-/);
  });

  // -------------------------------------------------------------------------
  // X-OpenClaw-Session-Key — per-user session scoping
  // -------------------------------------------------------------------------

  it("appends user suffix to session key when X-OpenClaw-Session-Key is provided", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "alice@example.com",
      },
      body: {
        threadId: "t-user",
        runId: "r-user",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:user:alice@example.com:thread:t-user");
  });

  it("composes user and thread suffixes together in order", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "alice",
      },
      body: {
        threadId: "t-1",
        runId: "r-1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:user:alice:thread:t-1");
  });

  it("namespaces header value under route.sessionKey and never replaces it", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "totally-different",
      },
      body: {
        threadId: "t-hostile",
        runId: "r-hostile",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey.startsWith("agui:test-session:")).toBe(true);
    expect(call.sessionKey).toContain(":user:totally-different");
  });

  it("falls back to route.sessionKey scoping when X-OpenClaw-Session-Key is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-nouser",
        runId: "r-nouser",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:t-nouser");
    expect(call.sessionKey).not.toContain(":user:");
  });

  it.each([
    ["path traversal", "../evil"],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["null byte", "a\0b"],
  ])(
    "rejects X-OpenClaw-Session-Key with %s (400 invalid_request_error)",
    async (_label, value) => {
      const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
      const req = createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-session-key": value,
        },
        body: {
          threadId: "t",
          runId: "r",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const res = createRes();
      await handler(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.chunks.join(""));
      expect(body.error.type).toBe("invalid_request_error");
    },
  );

  it("rejects X-OpenClaw-Session-Key exceeding 256 characters", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "a".repeat(257),
      },
      body: {
        threadId: "t",
        runId: "r",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.chunks.join(""));
    expect(body.error.type).toBe("invalid_request_error");
  });

  it.each([
    ["whitespace", "alice space"],
    ["exclamation", "alice!"],
    ["hash", "alice#b"],
  ])("rejects X-OpenClaw-Session-Key with disallowed character (%s)", async (_label, value) => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": value,
      },
      body: {
        threadId: "t",
        runId: "r",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it.each([
    ["email", "alice@example.com"],
    ["uuid", "12345678-1234-1234-1234-123456789abc"],
    ["colon-separated", "tenant-1:alice"],
    ["dot-and-underscore", "user_1.alice"],
  ])(
    "accepts well-formed identifier (%s) and composes it under route.sessionKey",
    async (_label, value) => {
      const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
      const req = createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-session-key": value,
        },
        body: {
          threadId: "t-ok",
          runId: "r-ok",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const res = createRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const rt = fakeApi.runtime;
      const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
      expect(call.sessionKey).toBe(`agui:test-session:user:${value}:thread:t-ok`);
    },
  );

  it("does not call resolveAgentRoute or runEmbeddedAgent when X-OpenClaw-Session-Key is invalid", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "../escape",
      },
      body: {
        threadId: "t",
        runId: "r",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(rt.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("handles client disconnect by aborting", async () => {
    const rt = fakeApi.runtime;
    let capturedAbortSignal: AbortSignal | undefined;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      capturedAbortSignal = params.abortSignal;
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Disconnect is observed on the RESPONSE (and its socket), not the request:
    // by the time the stream is open the request body is fully consumed, so a
    // `close` listener on `req` has already fired and never reports the client
    // going away mid-run.
    (res as unknown as EventEmitter).emit("close");

    expect(capturedAbortSignal).toBeDefined();
    expect(capturedAbortSignal!.aborted).toBe(true);
  });

  it("advertises text/event-stream even when the client's Accept prefers protobuf", async () => {
    // encode() only ever produces SSE frames, so the response must not claim to
    // be protobuf — a client that trusted the header would fail to parse the body.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.ag-ui.event+proto",
      },
      body: {
        threadId: "t-proto",
        runId: "r-proto",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.chunks.join("")).toContain("data: ");
  });

  it("keeps the session claimed after a mid-run disconnect so a concurrent run cannot steal the stream", async () => {
    // Aborting only *requests* that the agent stop; tool hooks can still fire
    // while the run unwinds. If the disconnect released ownership, a second
    // request could claim the session and install its writer, and this run's
    // late tool events — resolved by sessionKey alone — would land in it.
    const rt = fakeApi.runtime;
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    rt.agent.runEmbeddedAgent.mockImplementation(async () => {
      await runGate;
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const makeReq = () =>
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-hold",
          runId: "r-hold",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

    const resA = createRes();
    const runA = handler(makeReq(), resA);
    // Let A get past body parsing and claim the session.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    // Client A goes away while the run is still in flight.
    (resA as unknown as EventEmitter).emit("close");

    // A still owns the session, so B must be refused rather than take the stream.
    const resB = createRes();
    await handler(makeReq(), resB);
    expect(resB.statusCode).toBe(409);

    // Once A's finally runs, ownership is released and the session is reusable.
    releaseRun?.();
    await runA;

    const resC = createRes();
    await handler(makeReq(), resC);
    expect(resC.statusCode).toBe(200);
  });
});
