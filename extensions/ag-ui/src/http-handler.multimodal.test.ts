import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Split out of http-handler.test.ts to keep both files under the `max-lines`
// cap. Covers what non-text content the handler forwards to the model.

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

import { createAguiHttpHandler } from "./http-handler.js";
import {
  createReq,
  createRes,
  createDeviceToken,
  createFakeApi,
  parseEvents,
  GATEWAY_SECRET,
  APPROVED_DEVICE_ID,
} from "./http-handler.test-helpers.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAAP4AAQaMBWQAAAABJRU5ErkJggg==";

function imageMessage(role: string, text: string, data: string) {
  return {
    role,
    content: [
      { type: "text", text },
      { type: "image", source: { type: "data", value: data, mimeType: "image/png" } },
    ],
  };
}

describe("AG-UI multimodal image forwarding", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
  });

  function post(body: unknown) {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    return handler(createReq({ headers: { authorization: `Bearer ${token}` }, body }), createRes());
  }

  it("forwards an image sent on the current turn", async () => {
    await post({
      threadId: "t-img",
      runId: "r-img",
      messages: [imageMessage("user", "What is this?", PNG_1PX)],
    });

    const call = fakeApi.runtime.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.images).toHaveLength(1);
  });

  it("accepts an empty frontend tool result instead of dead-ending the run", async () => {
    // A frontend tool that succeeds with no output sends `content: ""`. That
    // carries no text and no image, but it IS the turn — rejecting it strands
    // the run right after the browser did the work.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-emptytool",
          runId: "r-emptytool",
          messages: [
            { role: "user", content: "make it blue" },
            { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function" }] },
            { role: "tool", toolCallId: "call-1", content: "" },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).not.toBe(400);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).toHaveBeenCalled();
  });

  // Core rejects a colliding tool set, but only inside the run — after SSE is
  // committed and the session may already be upserted. These must land on the
  // documented 400 with no stream and no run.
  it.each([
    [
      "two tools with the same name",
      [
        { name: "dupe", description: "a", parameters: {} },
        { name: "dupe", description: "b", parameters: {} },
      ],
      undefined,
    ],
    [
      "names differing only by case",
      [
        { name: "Dupe", description: "a", parameters: {} },
        { name: "dupe", description: "b", parameters: {} },
      ],
      undefined,
    ],
    [
      "a tool colliding with an injected state-writer",
      [{ name: "set_notes", description: "a", parameters: {} }],
      { stateWriterTools: [{ name: "set_notes", stateKey: "notes" }] },
    ],
  ])("rejects %s before opening the stream", async (_label, tools, forwardedProps) => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-conflict",
          runId: "r-conflict",
          messages: [{ role: "user", content: "hi" }],
          tools,
          ...(forwardedProps ? { forwardedProps } : {}),
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.chunks[0]!).error.message).toContain("Conflicting tool names");
    expect(parseEvents(res.chunks)).toHaveLength(0);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rejects two state writers sharing a name", async () => {
    // Both halves of the combined set are injected into the same clientTools
    // array, so state writers can collide with each other, not just with the
    // browser's declared tools.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-sw-dupe",
          runId: "r-sw-dupe",
          messages: [{ role: "user", content: "hi" }],
          forwardedProps: {
            stateWriterTools: [
              { name: "set_notes", stateKey: "notes" },
              { name: "set_notes", stateKey: "other" },
            ],
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.chunks[0]!).error.message).toContain("Conflicting tool names");
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("validates tools on an empty init/sync request too", async () => {
    // The empty-messages path returns a 200 empty run early. Tool validation has
    // to precede it, or the contract holds on turns that run an agent and
    // silently lapses on session init.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-init-tools",
          runId: "r-init-tools",
          messages: [],
          tools: [
            { name: "dupe", description: "a", parameters: {} },
            { name: "dupe", description: "b", parameters: {} },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(parseEvents(res.chunks)).toHaveLength(0);
  });

  it("accepts distinct tool names alongside a state writer", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-ok",
          runId: "r-ok",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "change_background", description: "a", parameters: {} }],
          forwardedProps: { stateWriterTools: [{ name: "set_notes", stateKey: "notes" }] },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).toHaveBeenCalled();
  });

  it("rejects an oversized declared toolset before committing the stream", async () => {
    // Tool schemas reach the model verbatim, so they are capped like context and
    // state. The rejection must be a clean 400, not a half-written SSE stream.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-bigtools",
          runId: "r-bigtools",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ name: "huge", description: "x".repeat(30_000), parameters: {} }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  // A malformed `tools` payload must fail on the documented 400 path, BEFORE the
  // run is admitted — not as a committed SSE 200 + RUN_ERROR with a session entry
  // already written. Core enforces the same invariant at the equivalent boundary
  // (extractClientToolsFromChatRequest, src/gateway/openai-http.ts).
  it.each([
    ["a non-array tools value", {}, "`tools` must be an array."],
    ["a null entry", [null], "`tools[0]` must be an object."],
    ["an entry that is not an object", ["nope"], "`tools[0]` must be an object."],
    ["an entry with no name", [{ description: "x" }], "`tools[0].name` is required."],
    ["an entry with a blank name", [{ name: "   " }], "`tools[0].name` is required."],
  ])("rejects %s with 400 before opening the stream", async (_label, tools, message) => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-badtools",
          runId: "r-badtools",
          messages: [{ role: "user", content: "hi" }],
          tools,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.chunks[0]!).error.message).toBe(message);
    // No stream, and no session side effects from a rejected request.
    expect(parseEvents(res.chunks)).toHaveLength(0);
    expect(fakeApi.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("accepts an image-only turn instead of rejecting it as an empty prompt", async () => {
    // A pasted/dragged image with no caption is a normal multimodal turn, but
    // the prompt builder only extracts text — so a text-empty body must not be
    // treated as an empty request.
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const res = createRes();
    await handler(
      createReq({
        headers: { authorization: `Bearer ${token}` },
        body: {
          threadId: "t-img-only",
          runId: "r-img-only",
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "data", value: PNG_1PX, mimeType: "image/png" } },
              ],
            },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).not.toBe(400);
    const call = fakeApi.runtime.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.images).toHaveLength(1);
  });

  it("does not resend an image from an earlier turn on a text-only turn", async () => {
    // AG-UI clients POST the whole transcript every turn. Extracting images from
    // all of it resent turn 1's image with turn 2's text, so the model answered
    // against a stale image and the attachment was duplicated in the session.
    // Image extraction is scoped to the same post-assistant delta as the prompt.
    await post({
      threadId: "t-img2",
      runId: "r-img2",
      messages: [
        imageMessage("user", "What is this?", PNG_1PX),
        { role: "assistant", content: "It is a single pixel." },
        { role: "user", content: "Thanks — now tell me a joke." },
      ],
    });

    const call = fakeApi.runtime.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.images).toBeUndefined();
    expect(call.prompt).toContain("tell me a joke");
  });
});
