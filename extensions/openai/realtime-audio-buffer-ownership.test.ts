import { once } from "node:events";
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeProviderKind = "native" | "gpt-live";

function parseWebSocketMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function withRealtimeProvider(
  kind: RealtimeProviderKind,
  prepareAudio: (bridge: RealtimeVoiceBridge) => void,
): Promise<Array<Record<string, unknown>>> {
  const audioEventType = kind === "native" ? "input_audio_buffer.append" : "input_audio.append";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an available local realtime WebSocket address");
  }
  const received: Array<Record<string, unknown>> = [];
  server.once("connection", (socket) => {
    socket.on("message", (payload) => {
      const event = parseWebSocketMessage(payload);
      received.push(event);
      if (event.type === "session.update") {
        socket.send(
          JSON.stringify(
            kind === "native"
              ? { type: "session.updated" }
              : {
                  type: "session.started",
                  session: { id: "fixture-live", expires_at: Math.floor(Date.now() / 1000) + 60 },
                },
          ),
        );
      }
    });
  });

  const endpoint = `http://127.0.0.1:${address.port}`;
  const bridge =
    kind === "native"
      ? buildOpenAIRealtimeVoiceProvider().createBridge({
          providerConfig: {
            apiKey: "fixture-local", // pragma: allowlist secret
            azureEndpoint: endpoint,
            azureDeployment: "fixture-realtime",
          },
          onAudio: vi.fn(),
          onClearAudio: vi.fn(),
        })
      : new OpenAIQuicksilverVoiceBridge(
          {
            providerConfig: {},
            model: "gpt-live-test-canary",
            audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
            resolveAuth: async () => ({ type: "api-key", token: "fixture-local" }),
            webSocketFactory: (_url, options) => new WebSocket(endpoint, options),
            onAudio: vi.fn(),
            onClearAudio: vi.fn(),
          },
          openAIRealtimeHost,
        );

  try {
    prepareAudio(bridge);
    await bridge.connect();
    await vi.waitFor(() => {
      expect(received.some((event) => event.type === audioEventType)).toBe(true);
    });
    return received;
  } finally {
    bridge.close();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("OpenAI realtime queued audio buffer ownership", () => {
  it.each<RealtimeProviderKind>(["native", "gpt-live"])(
    "%s preserves each reusable producer frame until the real WebSocket is ready",
    async (kind) => {
      const audioEventType = kind === "native" ? "input_audio_buffer.append" : "input_audio.append";
      const received = await withRealtimeProvider(kind, (bridge) => {
        const producerAllocation = Buffer.alloc(2 * 1024 * 1024, 0x7f);
        const producerView = producerAllocation.subarray(0, 1);
        bridge.sendAudio(producerView);
        producerAllocation[0] = 0x41;
        bridge.sendAudio(producerView);
        producerAllocation[0] = 0;
      });

      expect(received.filter((event) => event.type === audioEventType)).toEqual([
        { type: audioEventType, audio: "fw==" },
        { type: audioEventType, audio: "QQ==" },
      ]);
    },
  );

  it.each<RealtimeProviderKind>(["native", "gpt-live"])(
    "%s rejects oversized producer frames before allocating a queued copy",
    async (kind) => {
      const audioEventType = kind === "native" ? "input_audio_buffer.append" : "input_audio.append";
      const received = await withRealtimeProvider(kind, (bridge) => {
        const oversized = Buffer.alloc(1024 * 1024 + 1);
        const copyBuffer = vi.spyOn(Buffer, "from");
        try {
          bridge.sendAudio(oversized);
          expect(copyBuffer.mock.calls.some(([source]) => source === oversized)).toBe(false);
        } finally {
          copyBuffer.mockRestore();
        }
        bridge.sendAudio(Buffer.from([0x7f]));
      });

      expect(received.filter((event) => event.type === audioEventType)).toEqual([
        { type: audioEventType, audio: "fw==" },
      ]);
    },
  );
});
