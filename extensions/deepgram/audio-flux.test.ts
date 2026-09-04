import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { isDeepgramFluxModel } from "./audio-flux.js";
import { transcribeDeepgramAudio } from "./audio.js";

const runCommandBuffered = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveFfmpegBin: () => "/usr/bin/ffmpeg",
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandBuffered }));

const cleanups: Array<() => Promise<void>> = [];

function parseClientMessage(data: RawData): Record<string, unknown> | undefined {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(data.toString());
  return asOptionalRecord(parsed);
}

async function createFluxServer(params: {
  onCloseStream: (socket: WebSocket) => void;
  onRequest?: (url: URL, headers: Record<string, string | string[] | undefined>) => void;
}) {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const audioFrames: Buffer[] = [];
  server.on("upgrade", (request, socket, head) => {
    params.onRequest?.(new URL(request.url ?? "/", "http://127.0.0.1"), request.headers);
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          audioFrames.push(bytes);
          return;
        }
        if (parseClientMessage(data)?.type === "CloseStream") {
          params.onCloseStream(client);
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        for (const client of websocketServer.clients) {
          client.terminate();
        }
        websocketServer.close(() => server.close((error) => (error ? reject(error) : resolve())));
      }),
  );
  return { audioFrames, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function fluxRequest(
  baseUrl: string,
  extra: Partial<AudioTranscriptionRequest> = {},
): AudioTranscriptionRequest {
  return {
    buffer: Buffer.from("source audio"),
    fileName: "note.ogg",
    apiKey: "default-key",
    baseUrl,
    model: "flux-general-multi",
    timeoutMs: 5000,
    request: { allowPrivateNetwork: true },
    ...extra,
  };
}

function mockDecodedPcm(pcm: Buffer): void {
  runCommandBuffered.mockResolvedValueOnce({
    stdout: pcm,
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
}

describe("Deepgram Flux audio", () => {
  afterEach(async () => {
    runCommandBuffered.mockReset();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("routes documented Flux models only", () => {
    expect(isDeepgramFluxModel("flux-general-en")).toBe(true);
    expect(isDeepgramFluxModel(" Flux-General-Multi ")).toBe(true);
    expect(isDeepgramFluxModel("flux")).toBe(false);
    expect(isDeepgramFluxModel("reflux-general-en")).toBe(false);
    expect(isDeepgramFluxModel("nova-3")).toBe(false);
  });

  it("uses resolved auth and Flux protocol fields through the guarded socket", async () => {
    const pcm = Buffer.alloc(6000, 1);
    mockDecodedPcm(pcm);
    let requestUrl: URL | undefined;
    let authorization: string | string[] | undefined;
    const server = await createFluxServer({
      onRequest: (url, headers) => {
        requestUrl = url;
        authorization = headers.authorization;
      },
      onCloseStream: (socket) => {
        socket.send(
          JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "life moves" }),
        );
        socket.send(
          JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript: "pretty fast" }),
        );
        socket.close();
      },
    });

    const result = await transcribeDeepgramAudio(
      fluxRequest(server.baseUrl, {
        language: " en ",
        query: {
          eot_threshold: 0.7,
          numerals: true,
          profanity_filter: true,
          smart_format: true,
        },
        request: {
          allowPrivateNetwork: true,
          auth: {
            mode: "header",
            headerName: "authorization",
            value: "Token configured-key",
          },
        },
      }),
    );

    expect(result).toEqual({ model: "flux-general-multi", text: "life moves pretty fast" });
    expect(authorization).toBe("Token configured-key");
    expect(requestUrl?.pathname).toBe("/v2/listen");
    expect(requestUrl?.searchParams.get("encoding")).toBe("linear16");
    expect(requestUrl?.searchParams.get("sample_rate")).toBe("16000");
    expect(requestUrl?.searchParams.get("language_hint")).toBe("en");
    expect(requestUrl?.searchParams.get("eot_threshold")).toBe("0.7");
    expect(requestUrl?.searchParams.get("numerals")).toBe("true");
    expect(requestUrl?.searchParams.get("profanity_filter")).toBe("true");
    expect(requestUrl?.searchParams.has("smart_format")).toBe(false);
    expect(server.audioFrames.map((frame) => frame.byteLength)).toEqual([2560, 2560, 880]);
    expect(Buffer.concat(server.audioFrames)).toEqual(pcm);
    expect(runCommandBuffered).toHaveBeenCalledWith(
      expect.arrayContaining([
        "/usr/bin/ffmpeg",
        "-t",
        "1200",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "16000",
      ]),
      expect.objectContaining({
        maxOutputBytes: { stdout: 38_400_000, stderr: 65_536 },
        terminateOnOutputError: true,
      }),
    );
  });

  it.each(["null", "[]", "42"])("rejects valid non-object server JSON: %s", async (payload) => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    const server = await createFluxServer({
      onCloseStream: (socket) => socket.send(payload),
    });
    await expect(transcribeDeepgramAudio(fluxRequest(server.baseUrl))).rejects.toThrow(
      "malformed JSON response",
    );
  });

  it("rejects retained transcript growth above the provider limit", async () => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    const server = await createFluxServer({
      onCloseStream: (socket) =>
        socket.send(
          JSON.stringify({
            type: "TurnInfo",
            event: "EndOfTurn",
            transcript: "x".repeat(256 * 1024 + 1),
          }),
        ),
    });
    await expect(transcribeDeepgramAudio(fluxRequest(server.baseUrl))).rejects.toThrow(
      "transcript exceeds size limit",
    );
  });

  it("does not open a private socket without the request-policy opt-in", async () => {
    mockDecodedPcm(Buffer.alloc(10, 1));
    let opened = false;
    const server = await createFluxServer({
      onRequest: () => {
        opened = true;
      },
      onCloseStream: () => undefined,
    });
    await expect(
      transcribeDeepgramAudio(
        fluxRequest(server.baseUrl, { request: { allowPrivateNetwork: false } }),
      ),
    ).rejects.toThrow(/private|loopback|blocked/iu);
    expect(opened).toBe(false);
  });
});
