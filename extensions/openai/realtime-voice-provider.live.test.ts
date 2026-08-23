// OpenAI tests cover the native realtime voice bridge against the live API.
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE_ENABLED = OPENAI_API_KEY.length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;

describeLive("OpenAI realtime voice lifecycle live", () => {
  it("emits an incomplete response and then reuses the same session", async () => {
    const socket = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });
    const outcomes: Array<{ status?: string; reason?: string }> = [];
    const sendTurn = (text: string, maxOutputTokens: number) => {
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: { output_modalities: ["text"], max_output_tokens: maxOutputTokens },
        }),
      );
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Realtime live probe timed out")),
          45_000,
        );
        socket.on("message", (data) => {
          const payload = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          const event = JSON.parse(payload.toString("utf8")) as {
            type?: string;
            response?: { status?: string; status_details?: { reason?: string } | null };
            error?: { message?: string };
          };
          if (event.type === "error") {
            clearTimeout(timeout);
            reject(new Error(event.error?.message ?? "Realtime API error"));
          } else if (event.type === "session.created") {
            sendTurn("Write a detailed paragraph about ocean tides.", 1);
          } else if (event.type === "response.done") {
            outcomes.push({
              status: event.response?.status,
              reason: event.response?.status_details?.reason,
            });
            if (outcomes.length === 1) {
              sendTurn("Reply with exactly one word: ok", 100);
            } else {
              clearTimeout(timeout);
              resolve();
            }
          }
        });
        socket.on("error", reject);
      });
    } finally {
      socket.close();
    }

    expect(outcomes).toEqual([
      { status: "incomplete", reason: "max_output_tokens" },
      { status: "completed", reason: undefined },
    ]);
  }, 60_000);

  it("reuses a bridge after a terminal close", async () => {
    let closeCount = 0;
    let readyCount = 0;
    const errors: Error[] = [];
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: {
        apiKey: OPENAI_API_KEY,
        model: "gpt-realtime-2.1",
        voice: "marin",
      },
      instructions: "Keep this lifecycle verification session silent.",
      autoRespondToAudio: false,
      onAudio: () => {},
      onClearAudio: () => {},
      onClose: () => {
        closeCount += 1;
      },
      onError: (error) => {
        errors.push(error);
      },
      onReady: () => {
        readyCount += 1;
      },
    });

    try {
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      bridge.close();

      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
    } finally {
      bridge.close();
    }

    expect(errors).toEqual([]);
    expect(readyCount).toBe(2);
    expect(closeCount).toBe(2);
  }, 60_000);
});
