import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import { expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createEventManagerHarness,
  FakeProvider,
  finalizeTestManagerCalls,
} from "./manager.test-harness.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { connectWs } from "./websocket-test-support.js";
import { WebSocket } from "./websocket.js";

const fixture = vi.hoisted(() => ({
  acquire:
    vi.fn<
      typeof import("./realtime-transcription.runtime.js").acquireRealtimeTranscriptionProvider
    >(),
}));
vi.mock("./realtime-transcription.runtime.js", () => ({
  acquireRealtimeTranscriptionProvider: fixture.acquire,
  acquireRealtimeTranscriptionProviders() {
    throw new Error("Explicit synthetic provider must not discover others");
  },
}));

class StreamingCarrier extends FakeProvider {
  private readonly streams = new Map<string, string>();
  isValidStreamToken() {
    return true;
  }
  registerCallStream(callId: string, streamId: string) {
    this.streams.set(callId, streamId);
  }
  unregisterCallStream(callId: string, streamId: string) {
    if (this.streams.get(callId) === streamId) {
      this.streams.delete(callId);
    }
  }
  hasRegisteredStream(callId: string, streamId?: string) {
    return streamId ? this.streams.get(callId) === streamId : this.streams.has(callId);
  }
  clearTtsQueue() {}
}

function createNativeTranscriptionProvider(
  record: (name: string) => void,
  close?: () => void,
  finalTranscript?: string,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "native-transcription",
    label: "Native transcription",
    isConfigured: () => true,
    createSession(request) {
      record("factory");
      return {
        async connect() {
          await Promise.resolve();
          record("connect");
        },
        sendAudio() {
          record("audio");
        },
        close() {
          record("close");
          close?.();
          if (finalTranscript) {
            request.onTranscript?.(finalTranscript);
          }
        },
        isConnected() {
          record("connected");
          return true;
        },
      };
    },
  };
}

it.each([
  {
    name: "binds real webhook transcription connect, audio, and close to the acquired native context",
    failClose: false,
    restart: false,
    flushTranscript: false,
  },
  {
    name: "keeps failed MediaStream cleanup reachable through public webhook stop retry",
    failClose: true,
    restart: false,
    flushTranscript: false,
  },
  {
    name: "reacquires native provider resources for a second actual webhook stream generation",
    failClose: false,
    restart: true,
    flushTranscript: false,
  },
  {
    name: "preserves a final native transcription flush during graceful webhook close",
    failClose: false,
    restart: false,
    flushTranscript: true,
  },
])("$name", async ({ failClose, restart, flushTranscript }) => {
  const state = createEventManagerHarness();
  state.setup();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE operations (name TEXT, scoped INTEGER)");
  const context = new AsyncLocalStorage<DatabaseSync>();
  const record = (name: string) =>
    db.prepare("INSERT INTO operations VALUES (?, ?)").run(name, context.getStore() === db ? 1 : 0);
  let rows: unknown[] = [];
  let closed = false;
  let allowClose = !failClose;
  const closeFailure = new Error("native transcription close failed");
  const escapedCloseErrors: Error[] = [];
  // Observe only this synthetic failure at ws's real event boundary; every other event/error passes through.
  const emit = vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<WebSocket["emit"]>
  ) {
    try {
      return EventEmitter.prototype.emit.apply(this, args);
    } catch (error) {
      if (args[0] === "close" && error === closeFailure) {
        escapedCloseErrors.push(closeFailure);
        return true;
      }
      throw error;
    }
  });
  const finalTranscript = "Synthetic final words during close";
  const provider = createNativeTranscriptionProvider(
    record,
    () => {
      if (!allowClose) {
        throw closeFailure;
      }
    },
    flushTranscript ? finalTranscript : undefined,
  );
  fixture.acquire.mockReturnValue({
    provider,
    run: (operation) => context.run(db, operation),
    release() {
      if (closed) {
        return;
      }
      closed = true;
      rows = db.prepare("SELECT name, scoped FROM operations").all();
      db.close();
    },
  });
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550000000",
    skipSignatureVerification: true,
    streaming: { enabled: true, provider: provider.id },
  });
  config.serve.port = 0;
  const carrier = new StreamingCarrier("twilio");
  const manager = new CallManager(config, state.createContext({ config }).storePath);
  await manager.initialize(carrier, "https://example.test/voice/webhook");
  const call = await manager.initiateCall("+15550000001", undefined, { mode: "conversation" });
  expect(call.success).toBe(true);
  if (!call.callId) {
    throw new Error("Expected synthetic call identity");
  }
  const callId = call.callId;
  const server = new VoiceCallWebhookServer(config, manager, carrier);
  const url = await server.start();
  const ws = await connectWs(
    `${url.replace("http:", "ws:").replace(config.serve.path, "")}${config.streaming.streamPath}`,
  );
  let restartedWs: WebSocket | undefined;
  let restartedDb: DatabaseSync | undefined;
  try {
    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MZ-native",
        start: { callSid: "request-uuid" },
      }),
    );
    await vi.waitFor(() =>
      expect(db.prepare("SELECT name FROM operations WHERE name = 'connect'").all()).toHaveLength(
        1,
      ),
    );
    ws.send(
      JSON.stringify({
        event: "media",
        media: { payload: Buffer.from([1, 2]).toString("base64") },
      }),
    );
    await vi.waitFor(() =>
      expect(db.prepare("SELECT name FROM operations WHERE name = 'audio'").all()).toHaveLength(1),
    );
    if (failClose) {
      const firstStop = await server.stop().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(db.isOpen).toBe(true);
      expect(firstStop).toBe(closeFailure);
      expect(escapedCloseErrors).toEqual([]);
      await expect(server.stop()).rejects.toThrow("native transcription close failed");
      allowClose = true;
    }
    await server.stop();
    expect(db.isOpen).toBe(false);
    if (flushTranscript) {
      expect(manager.getCall(callId)?.transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ speaker: "user", text: finalTranscript }),
        ]),
      );
    }
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "factory", scoped: 1 },
        { name: "connect", scoped: 1 },
        { name: "audio", scoped: 1 },
        { name: "close", scoped: 1 },
      ]),
    );
    if (restart) {
      const nextDb = new DatabaseSync(":memory:");
      restartedDb = nextDb;
      nextDb.exec("CREATE TABLE operations (name TEXT, scoped INTEGER)");
      let nextRows: unknown[] = [];
      const nextProvider = createNativeTranscriptionProvider((name) => {
        nextDb
          .prepare("INSERT INTO operations VALUES (?, ?)")
          .run(name, context.getStore() === nextDb ? 1 : 0);
      });
      fixture.acquire.mockReturnValueOnce({
        provider: nextProvider,
        run: (operation) => context.run(nextDb, operation),
        release() {
          nextRows = nextDb.prepare("SELECT name, scoped FROM operations").all();
          nextDb.close();
        },
      });
      const nextUrl = await server.start();
      restartedWs = await connectWs(
        `${nextUrl.replace("http:", "ws:").replace(config.serve.path, "")}${config.streaming.streamPath}`,
      );
      restartedWs.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-next",
          start: { callSid: "request-uuid" },
        }),
      );
      await vi.waitFor(() =>
        expect(
          nextDb.prepare("SELECT name FROM operations WHERE name = 'connect'").all(),
        ).toHaveLength(1),
      );
      restartedWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.from([3, 4]).toString("base64") },
        }),
      );
      await vi.waitFor(() =>
        expect(
          nextDb.prepare("SELECT name FROM operations WHERE name = 'audio'").all(),
        ).toHaveLength(1),
      );
      await server.stop();
      expect(nextDb.isOpen).toBe(false);
      expect(nextRows).toEqual(
        expect.arrayContaining([
          { name: "factory", scoped: 1 },
          { name: "connect", scoped: 1 },
          { name: "audio", scoped: 1 },
          { name: "close", scoped: 1 },
        ]),
      );
    }
  } finally {
    allowClose = true;
    ws.terminate();
    restartedWs?.terminate();
    await server.stop();
    emit.mockRestore();
    finalizeTestManagerCalls(manager);
    state.cleanup();
    fixture.acquire.mockReset();
    if (db.isOpen) {
      db.close();
    }
    if (restartedDb?.isOpen) {
      restartedDb.close();
    }
  }
});
