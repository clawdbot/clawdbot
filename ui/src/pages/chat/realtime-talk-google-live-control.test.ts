import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createdSources,
  createTransport,
  encodeJsonFrame,
  getGoogleLiveToolOwnerState,
  installGoogleLiveTestFixture,
  startTransport,
} from "./realtime-talk-google-live.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./realtime-talk-shared.ts";

describe("GoogleLiveRealtimeTalkTransport control results", () => {
  installGoogleLiveTestFixture();

  it("surfaces Google Live tool-result send failures without an unhandled rejection", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({ onStatus, onTalkEvent }, client);

    const ws = await startTransport(transport);
    vi.spyOn(ws, "send").mockImplementation(() => {
      throw new Error("Google Live socket rejected the tool result");
    });
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-control",
              name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
              args: { text: "status", mode: "status" },
            },
          ],
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith("error", "Google Live socket rejected the tool result"),
    );
    expect(
      onTalkEvent.mock.calls.some(
        ([event]) =>
          (event.type === "tool.progress" || event.type === "tool.error") && event.final === true,
      ),
    ).toBe(false);
    expect(ws.readyState).toBe(3);
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-control")).toBe(false);
  });

  it("sends spoken active-control acknowledgements through Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "OpenClaw is working in read (running).",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    const ws = await startTransport(transport);
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await waitForFast(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "status", finished: true },
        },
      }),
    );

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent).toContainEqual({
      realtimeInput: {
        text: expect.stringContaining('Status: "OpenClaw is working in read (running)."'),
      },
    });
    transport.stop();
  });

  it("replaces queued output with a spoken active-control steering acknowledgement in Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "steer",
          sessionKey: "main",
          active: true,
          queued: true,
          message: "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    const ws = await startTransport(transport);
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await waitForFast(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "actually focus on WebUI", finished: true },
        },
      }),
    );

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent).toContainEqual({
      realtimeInput: {
        text: expect.stringContaining('Status: "Got it. I steered the active run."'),
      },
    });
    transport.stop();
  });

  it("interrupts queued output when active-control cancel is suppressed in Google Live", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockImplementation(async (method) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "cancel",
          sessionKey: "main",
          active: true,
          aborted: true,
          message: "Cancelled the active OpenClaw run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const transport = createTransport({}, client);
    const ws = await startTransport(transport);
    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await waitForFast(() => expect(createdSources).toHaveLength(1));
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "status?" },
            },
          ],
        },
      }),
    );
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
    );

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "cancel that", finished: true },
        },
      }),
    );

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
    );
    expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent.some((event) => event.clientContent)).toBe(false);
    transport.stop();
  });
});
