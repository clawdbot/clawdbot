// Deepgram tests cover realtime transcription provider plugin behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import {
  testing,
  buildDeepgramRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

let cleanup: (() => Promise<void>) | undefined;

async function createDeepgramRealtimeServer(params: {
  onRequest: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (request, socket, head) => {
    params.onRequest(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  cleanup = async () => {
    for (const ws of clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { baseUrl: `http://127.0.0.1:${port}/deepgram/v1` };
}

function buildTestRealtimeUrl(baseUrl: string): URL {
  return new URL(
    testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl,
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    }),
  );
}

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested provider config", () => {
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "dg-key",
      baseUrl: undefined,
      model: "nova-3",
      language: "en-US",
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 500,
    });
  });

  it("builds a Deepgram listen websocket URL", () => {
    const url = testing.toDeepgramRealtimeWsUrl({
      apiKey: "dg-key",
      baseUrl: "https://api.deepgram.com/v1",
      model: "nova-3",
      providerConfig: {},
      sampleRate: 8000,
      encoding: "mulaw",
      interimResults: true,
      endpointingMs: 800,
    });

    expect(url).toContain("wss://api.deepgram.com/v1/listen?");
    expect(url).toContain("model=nova-3");
    expect(url).toContain("encoding=mulaw");
    expect(url).toContain("sample_rate=8000");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });

  it("returns the default when no value or env is set", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "");
    expect(testing.normalizeDeepgramRealtimeBaseUrl(undefined)).toBe("https://api.deepgram.com/v1");
    expect(testing.normalizeDeepgramRealtimeBaseUrl("   ")).toBe("https://api.deepgram.com/v1");
  });

  it.each([
    ["http://localhost:8080/deepgram/v1", "ws:"],
    ["https://custom.example.com/deepgram/v1", "wss:"],
    ["ws://localhost:8080/deepgram/v1", "ws:"],
    ["wss://custom.example.com:8443/deepgram/v1", "wss:"],
  ])("maps or preserves %s as %s", (baseUrl, expectedProtocol) => {
    const url = buildTestRealtimeUrl(baseUrl);
    expect(url.protocol).toBe(expectedProtocol);
    expect(url.pathname).toBe("/deepgram/v1/listen");
  });

  it.each(["not a url", "ftp://files.example.com"])("rejects invalid endpoint %s", (baseUrl) => {
    expect(() => testing.normalizeDeepgramRealtimeBaseUrl(baseUrl)).toThrow(
      /^Invalid Deepgram baseUrl:/,
    );
  });

  it("validates the environment override", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "not a url");
    expect(() => testing.normalizeDeepgramRealtimeBaseUrl()).toThrow(
      "Invalid Deepgram baseUrl: value is not a valid URL",
    );
  });

  it("does not echo the configured URL in validation errors", () => {
    const rawMarker = "configured-value-marker";
    const nonHttp = `ftp://files.example.com/${rawMarker}`;
    try {
      testing.normalizeDeepgramRealtimeBaseUrl(nonHttp);
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/unsupported scheme/);
      expect(message).not.toContain(rawMarker);
    }
  });

  it("connects through an explicit HTTP base URL over loopback WebSocket", async () => {
    const requests: Array<{
      url: URL;
      headers: Record<string, string | string[] | undefined>;
    }> = [];
    const server = await createDeepgramRealtimeServer({
      onRequest: (url, headers) => requests.push({ url, headers }),
    });
    const provider = buildDeepgramRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "dummy",
        baseUrl: server.baseUrl,
      },
    });

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe("/deepgram/v1/listen");
    expect(requests[0]?.url.searchParams.get("model")).toBe("nova-3");
    expect(requests[0]?.headers.authorization).toBe("Token dummy");
  });
});
