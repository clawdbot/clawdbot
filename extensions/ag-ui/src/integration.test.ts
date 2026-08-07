import { createHmac } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Skip the entire suite unless OPENCLAW_SERVER_URL is set
// ---------------------------------------------------------------------------

const serverUrl = process.env.OPENCLAW_SERVER_URL;
const baseUrl = serverUrl ? `${serverUrl}:18789/v1/ag-ui` : "";

// Accept either a pre-built device token or auto-generate one from the
// gateway token + an approved device ID.
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const deviceToken = process.env.AG_UI_DEVICE_TOKEN ?? "";
const approvedDeviceId = process.env.AG_UI_DEVICE_ID ?? "";

function buildDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

// Resolve the token: explicit device token > auto-generated from gateway secret + device ID
const token =
  deviceToken ||
  (gatewayToken && approvedDeviceId ? buildDeviceToken(gatewayToken, approvedDeviceId) : "");

const describeIntegration = serverUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: EventType;
  [key: string]: unknown;
}

async function postRun(
  body: Record<string, unknown>,
  opts: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });
}

function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^data:\s*(.+)$/);
    if (match?.[1]) {
      try {
        events.push(JSON.parse(match[1]));
      } catch {
        /* skip non-JSON lines */
      }
    }
  }
  return events;
}

async function collectEvents(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  return parseSSEEvents(text);
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describeIntegration("ag-ui integration", () => {
  beforeAll(() => {
    if (!token) {
      throw new Error(
        "Set AG_UI_DEVICE_TOKEN, or both OPENCLAW_GATEWAY_TOKEN and AG_UI_DEVICE_ID, for integration tests",
      );
    }
  });

  // -- HTTP method / auth ------------------------------------------------

  it("rejects GET with 405", async () => {
    const res = await fetch(baseUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it("initiates pairing when no auth header is provided (403)", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "int-test",
        runId: "run-1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.pairing.token).toBeDefined();
    expect(body.error.pairing.pairingCode).toBeDefined();
  });

  it("rejects bad token with 401", async () => {
    const res = await postRun(
      {
        threadId: "int-test",
        runId: "run-1",
        messages: [{ role: "user", content: "hi" }],
      },
      { headers: { Authorization: "Bearer wrong-token" } },
    );
    expect(res.status).toBe(401);
  });

  // -- Validation --------------------------------------------------------

  it("refuses system messages on the paired route", async () => {
    // This suite posts to /v1/ag-ui with a device token — the untrusted route.
    // system/developer messages become the run's extraSystemPrompt, i.e.
    // authority over the agent's instructions, which a paired device does not
    // have. Empty init/sync is covered by the next case.
    const res = await postRun({
      threadId: "int-test",
      runId: "run-1",
      messages: [{ role: "system", content: "sys" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns empty SSE run when messages array is empty (AG-UI init/sync)", async () => {
    const res = await postRun({
      threadId: "int-test",
      runId: "run-1",
      messages: [],
    });
    expect(res.status).toBe(200);
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // -- SSE stream --------------------------------------------------------

  it("returns SSE stream with RUN_STARTED and RUN_FINISHED", async () => {
    const res = await postRun({
      threadId: `int-${Date.now()}`,
      runId: `run-${Date.now()}`,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("includes threadId and runId in RUN_STARTED", async () => {
    const threadId = `int-tid-${Date.now()}`;
    const runId = `int-rid-${Date.now()}`;
    const res = await postRun({
      threadId,
      runId,
      messages: [{ role: "user", content: "Hello" }],
    });
    const events = await collectEvents(res);
    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    expect(started?.threadId).toBe(threadId);
    expect(started?.runId).toBe(runId);
  });

  it("generates threadId and runId when not provided", async () => {
    const res = await postRun({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(res.status).toBe(200);
    const events = await collectEvents(res);
    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    expect(started?.threadId).toBeDefined();
    expect(started?.runId).toBeDefined();
  });

  // -- Agent response ----------------------------------------------------

  it("streams text content from agent", async () => {
    const res = await postRun({
      threadId: `int-text-${Date.now()}`,
      runId: `run-text-${Date.now()}`,
      messages: [{ role: "user", content: "Say hello" }],
    });
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);

    // The agent should produce at least some text
    if (types.includes(EventType.TEXT_MESSAGE_START)) {
      expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
      expect(types).toContain(EventType.TEXT_MESSAGE_END);

      const contentEvents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
      const fullText = contentEvents.map((e) => e.delta).join("");
      expect(fullText.length).toBeGreaterThan(0);
    }

    // Either way, run must finish
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // -- Multi-message context ---------------------------------------------

  it("handles multi-turn conversation context", async () => {
    const res = await postRun({
      threadId: `int-multi-${Date.now()}`,
      runId: `run-multi-${Date.now()}`,
      messages: [
        { role: "user", content: "My name is TestUser" },
        { role: "assistant", content: "Nice to meet you, TestUser!" },
        { role: "user", content: "What is my name?" },
      ],
    });
    expect(res.status).toBe(200);
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // -- Tool call events --------------------------------------------------

  it("emits well-formed TOOL_CALL events when agent uses tools", async () => {
    // Ask something likely to trigger tool use (e.g. search, calculation).
    // Even if the agent doesn't use tools, we verify the stream is valid.
    const res = await postRun({
      threadId: `int-tool-${Date.now()}`,
      runId: `run-tool-${Date.now()}`,
      messages: [{ role: "user", content: "What is 2+2? Use a tool if you can." }],
    });
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);

    // If tool calls were emitted, verify structure
    const toolStarts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
    // Every start must have a matching end
    expect(toolStarts.length).toBe(toolEnds.length);
    for (const start of toolStarts) {
      expect(start.toolCallId).toBeDefined();
      expect(typeof start.toolCallId).toBe("string");
      const matchingEnd = toolEnds.find((e) => e.toolCallId === start.toolCallId);
      expect(matchingEnd).toBeDefined();
    }

    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // -- Client-provided tools ----------------------------------------------

  it("accepts client-provided tools and finishes the run after tool call events", async () => {
    // Client tools are fire-and-forget: the run emits TOOL_CALL_START/ARGS/END
    // then finishes. The client executes the tool and starts a new run with
    // the result. The stream should NOT hang.
    const res = await postRun({
      threadId: `int-client-tool-${Date.now()}`,
      runId: `run-client-tool-${Date.now()}`,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city. Returns temperature in Fahrenheit.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            "What is the weather in Tokyo? You MUST use the get_weather tool to answer. Do not answer without calling the tool first.",
        },
      ],
    });
    expect(res.status).toBe(200);
    const events = await collectEvents(res);
    const types = events.map((e) => e.type);

    // The run must always finish (no hanging)
    expect(types).toContain(EventType.RUN_FINISHED);

    // If the agent called the tool, verify START/ARGS/END sequence
    const toolStarts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    if (toolStarts.length > 0) {
      const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(toolStarts.length).toBe(toolEnds.length);
      for (const start of toolStarts) {
        expect(start.toolCallId).toBeDefined();
        const matchingEnd = toolEnds.find((e) => e.toolCallId === start.toolCallId);
        expect(matchingEnd).toBeDefined();
      }
      // Client tools should NOT have TOOL_CALL_RESULT (no server-side result)
      const toolResults = events.filter(
        (e) =>
          e.type === EventType.TOOL_CALL_RESULT &&
          toolStarts.some((s) => s.toolCallId === e.toolCallId),
      );
      expect(toolResults.length).toBe(0);
    }
  });

  // -- Concurrent requests -----------------------------------------------

  it("handles concurrent requests with different threadIds", { timeout: 60_000 }, async () => {
    const requests = Array.from({ length: 3 }, (_, i) =>
      postRun({
        threadId: `int-concurrent-${Date.now()}-${i}`,
        runId: `run-concurrent-${Date.now()}-${i}`,
        messages: [{ role: "user", content: `Concurrent request ${i}` }],
      }),
    );
    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const events = await collectEvents(res);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types).toContain(EventType.RUN_FINISHED);
    }
  });
});
