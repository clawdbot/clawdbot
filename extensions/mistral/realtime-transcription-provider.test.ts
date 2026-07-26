// Mistral tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

let cleanup: (() => Promise<void>) | undefined;

async function createRealtimeServer(onRequest: (url: URL) => void) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (request, socket, head) => {
    onRequest(new URL(request.url ?? "/", "http://127.0.0.1"));
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => {
        clients.delete(ws);
      });
      ws.send(JSON.stringify({ type: "session.created" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe("buildMistralRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "mistral-key",
            model: "voxtral-mini-transcribe-realtime-2602",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            target_streaming_delay_ms: "240",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "mistral-key",
      baseUrl: undefined,
      model: "voxtral-mini-transcribe-realtime-2602",
      encoding: "pcm_mulaw",
      sampleRate: 8000,
      targetStreamingDelayMs: 240,
    });
  });

  it("normalizes pasted API key artifacts for realtime auth headers", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "  sk-\r\nmistral│  ",
          },
        },
      },
    });

    expect(resolved?.apiKey).toBe("sk-mistral");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    const provider = buildMistralRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Mistral API key missing");
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const requests: URL[] = [];
    const baseUrl = await createRealtimeServer((url) => requests.push(url));
    const session = buildMistralRealtimeTranscriptionProvider().createSession({
      providerConfig: {
        apiKey: "fixture-value",
        baseUrl,
        model: "voxtral-mini-transcribe-realtime-2602",
        sampleRate: 8000,
        encoding: "pcm_mulaw",
        targetStreamingDelayMs: 800,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/audio/transcriptions/realtime");
    expect(requests[0]?.searchParams.get("model")).toBe("voxtral-mini-transcribe-realtime-2602");
    expect(requests[0]?.searchParams.get("target_streaming_delay_ms")).toBe("800");
  });
});
