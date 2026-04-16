import "fake-indexeddb/auto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (!input) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

class FakeMatrixEvent extends EventEmitter {
  private readonly roomId: string;
  private readonly eventId: string;
  private readonly sender: string;
  private readonly type: string;
  private readonly ts: number;
  private readonly content: Record<string, unknown>;
  private readonly stateKey?: string;
  private readonly unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
  private readonly decryptionFailure: boolean;

  constructor(params: {
    roomId: string;
    eventId: string;
    sender: string;
    type: string;
    ts: number;
    content: Record<string, unknown>;
    stateKey?: string;
    unsigned?: {
      age?: number;
      redacted_because?: unknown;
    };
    decryptionFailure?: boolean;
  }) {
    super();
    this.roomId = params.roomId;
    this.eventId = params.eventId;
    this.sender = params.sender;
    this.type = params.type;
    this.ts = params.ts;
    this.content = params.content;
    this.stateKey = params.stateKey;
    this.unsigned = params.unsigned;
    this.decryptionFailure = params.decryptionFailure === true;
  }

  getRoomId(): string {
    return this.roomId;
  }

  getId(): string {
    return this.eventId;
  }

  getSender(): string {
    return this.sender;
  }

  getType(): string {
    return this.type;
  }

  getTs(): number {
    return this.ts;
  }

  getContent(): Record<string, unknown> {
    return this.content;
  }

  getUnsigned(): { age?: number; redacted_because?: unknown } {
    return this.unsigned ?? {};
  }

  getStateKey(): string | undefined {
    return this.stateKey;
  }

  isDecryptionFailure(): boolean {
    return this.decryptionFailure;
  }
}

type MatrixJsClientStub = {
  emit: (eventName: string | symbol, ...args: unknown[]) => boolean;
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MatrixJsClientStub;
  startClient: ReturnType<typeof vi.fn>;
  stopClient: ReturnType<typeof vi.fn>;
  initRustCrypto: ReturnType<typeof vi.fn>;
  getUserId: ReturnType<typeof vi.fn>;
  getDeviceId: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedRoomMembers: ReturnType<typeof vi.fn>;
  getStateEvent: ReturnType<typeof vi.fn>;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  getRoomIdForAlias: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  sendStateEvent: ReturnType<typeof vi.fn>;
  redactEvent: ReturnType<typeof vi.fn>;
  getProfileInfo: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  mxcUrlToHttp: ReturnType<typeof vi.fn>;
  uploadContent: ReturnType<typeof vi.fn>;
  fetchRoomEvent: ReturnType<typeof vi.fn>;
  getEventMapper: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  getRooms: ReturnType<typeof vi.fn>;
  getCrypto: ReturnType<typeof vi.fn>;
  decryptEventIfNeeded: ReturnType<typeof vi.fn>;
  relations: ReturnType<typeof vi.fn>;
};

function createMatrixJsClientStub(): MatrixJsClientStub {
  const client = new EventEmitter() as unknown as MatrixJsClientStub;
  client.startClient = vi.fn(async () => {
    queueMicrotask(() => {
      client.emit("sync", "PREPARED", null, undefined);
    });
  });
  client.stopClient = vi.fn();
  client.initRustCrypto = vi.fn(async () => {});
  client.getUserId = vi.fn(() => "@bot:example.org");
  client.getDeviceId = vi.fn(() => "DEVICE123");
  client.getJoinedRooms = vi.fn(async () => ({ joined_rooms: [] }));
  client.getJoinedRoomMembers = vi.fn(async () => ({ joined: {} }));
  client.getStateEvent = vi.fn(async () => ({}));
  client.getAccountData = vi.fn(() => undefined);
  client.setAccountData = vi.fn(async () => {});
  client.getRoomIdForAlias = vi.fn(async () => ({ room_id: "!resolved:example.org" }));
  client.sendMessage = vi.fn(async () => ({ event_id: "$sent" }));
  client.sendEvent = vi.fn(async () => ({ event_id: "$sent-event" }));
  client.sendStateEvent = vi.fn(async () => ({ event_id: "$state" }));
  client.redactEvent = vi.fn(async () => ({ event_id: "$redact" }));
  client.getProfileInfo = vi.fn(async () => ({}));
  client.joinRoom = vi.fn(async () => ({}));
  client.mxcUrlToHttp = vi.fn(() => null);
  client.uploadContent = vi.fn(async () => ({ content_uri: "mxc://example/file" }));
  client.fetchRoomEvent = vi.fn(async () => ({}));
  client.getEventMapper = vi.fn(
    () =>
      (
        raw: Partial<{
          room_id: string;
          event_id: string;
          sender: string;
          type: string;
          origin_server_ts: number;
          content: Record<string, unknown>;
          state_key?: string;
          unsigned?: { age?: number; redacted_because?: unknown };
        }>,
      ) =>
        new FakeMatrixEvent({
          roomId: raw.room_id ?? "!mapped:example.org",
          eventId: raw.event_id ?? "$mapped",
          sender: raw.sender ?? "@mapped:example.org",
          type: raw.type ?? "m.room.message",
          ts: raw.origin_server_ts ?? Date.now(),
          content: raw.content ?? {},
          stateKey: raw.state_key,
          unsigned: raw.unsigned,
        }),
  );
  client.sendTyping = vi.fn(async () => {});
  client.getRoom = vi.fn(() => ({ hasEncryptionStateEvent: () => false }));
  client.getRooms = vi.fn(() => []);
  client.getCrypto = vi.fn(() => undefined);
  client.decryptEventIfNeeded = vi.fn(async () => {});
  client.relations = vi.fn(async () => ({
    originalEvent: null,
    events: [],
    nextBatch: null,
    prevBatch: null,
  }));
  return client;
}

let matrixJsClient = createMatrixJsClientStub();
let lastCreateClientOpts: Record<string, unknown> | null = null;

vi.mock("matrix-js-sdk/lib/matrix.js", async () => {
  const actual = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
    "matrix-js-sdk/lib/matrix.js",
  );
  return {
    ...actual,
    ClientEvent: {
      Event: "event",
      Room: "Room",
      Sync: "sync",
      SyncUnexpectedError: "sync.unexpectedError",
    },
    MatrixEventEvent: { Decrypted: "decrypted" },
    createClient: vi.fn((opts: Record<string, unknown>) => {
      lastCreateClientOpts = opts;
      return matrixJsClient;
    }),
  };
});

const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key.js");
const { MatrixClient } = await import("./sdk.js");

describe("MatrixClient request hardening", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("blocks absolute endpoints unless explicitly allowed", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("https://matrix.example.org", "token");
    await expect(client.doRequest("GET", "https://matrix.example.org/start")).rejects.toThrow(
      "Absolute Matrix endpoint is blocked by default",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects a guarded fetchFn into matrix-js-sdk", () => {
    const client = new MatrixClient("https://matrix.example.org", "token", {
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    expect(client).toBeInstanceOf(MatrixClient);

    expect(lastCreateClientOpts).toMatchObject({
      baseUrl: "https://matrix.example.org",
      accessToken: "token",
    });
    expect(lastCreateClientOpts?.fetchFn).toEqual(expect.any(Function));
  });

  it("prefers authenticated client media downloads", async () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(payload, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("http://127.0.0.1:8008", "token", {
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    await expect(client.downloadContent("mxc://example.org/media")).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstInput = (fetchMock.mock.calls as Array<[RequestInfo | URL]>)[0]?.[0];
    const firstUrl = requestUrl(firstInput);
    expect(firstUrl).toContain("/_matrix/client/v1/media/download/example.org/media");
  });

  it("falls back to legacy media downloads for older homeservers", async () => {
    const payload = Buffer.from([5, 6, 7, 8]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/_matrix/client/v1/media/download/")) {
        return new Response(
          JSON.stringify({
            errcode: "M_UNRECOGNIZED",
            error: "Unrecognized request",
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(payload, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("http://127.0.0.1:8008", "token", {
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    await expect(client.downloadContent("mxc://example.org/media")).resolves.toEqual(payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = fetchMock.mock.calls as Array<[RequestInfo | URL]>;
    const firstInput = firstCall?.[0];
    const secondInput = secondCall?.[0];
    const firstUrl = requestUrl(firstInput);
    const secondUrl = requestUrl(secondInput);
    expect(firstUrl).toContain("/_matrix/client/v1/media/download/example.org/media");
    expect(secondUrl).toContain("/_matrix/media/v3/download/example.org/media");
  });

  it("decrypts encrypted room events returned by getEvent", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    matrixJsClient.fetchRoomEvent = vi.fn(async () => ({
      room_id: "!room:example.org",
      event_id: "$poll",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      origin_server_ts: 1,
      content: {},
    }));
    matrixJsClient.decryptEventIfNeeded = vi.fn(async (event: FakeMatrixEvent) => {
      event.emit(
        "decrypted",
        new FakeMatrixEvent({
          roomId: "!room:example.org",
          eventId: "$poll",
          sender: "@alice:example.org",
          type: "m.poll.start",
          ts: 1,
          content: {
            "m.poll.start": {
              question: { "m.text": "Lunch?" },
              answers: [{ id: "a1", "m.text": "Pizza" }],
            },
          },
        }),
      );
    });

    const event = await client.getEvent("!room:example.org", "$poll");

    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      event_id: "$poll",
      type: "m.poll.start",
      sender: "@alice:example.org",
    });
  });

  it("serializes outbound sends per room across message and event sends", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
    matrixJsClient.sendMessage = vi.fn(async () => {
      started.push("message");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { event_id: "$message" };
    });
    matrixJsClient.sendEvent = vi.fn(async () => {
      started.push("event");
      return { event_id: "$event" };
    });

    const first = client.sendMessage("!room:example.org", {
      msgtype: "m.text",
      body: "hello",
    });
    const second = client.sendEvent("!room:example.org", "m.reaction", {
      "m.relates_to": { event_id: "$target", key: "👍", rel_type: "m.annotation" },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["message"]);
    expect(matrixJsClient.sendEvent).not.toHaveBeenCalled();

    releaseFirst?.();

    await expect(first).resolves.toBe("$message");
    await expect(second).resolves.toBe("$event");
    expect(started).toEqual(["message", "event"]);
  });

  it("does not serialize sends across different rooms", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
    matrixJsClient.sendMessage = vi.fn(async (roomId: string) => {
      started.push(roomId);
      if (roomId === "!room-a:example.org") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { event_id: `$${roomId}` };
    });

    const first = client.sendMessage("!room-a:example.org", {
      msgtype: "m.text",
      body: "a",
    });
    const second = client.sendMessage("!room-b:example.org", {
      msgtype: "m.text",
      body: "b",
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["!room-a:example.org", "!room-b:example.org"]);

    releaseFirst?.();

    await expect(first).resolves.toBe("$!room-a:example.org");
    await expect(second).resolves.toBe("$!room-b:example.org");
  });

  it("maps relations pages back to raw events", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    matrixJsClient.relations = vi.fn(async () => ({
      originalEvent: new FakeMatrixEvent({
        roomId: "!room:example.org",
        eventId: "$poll",
        sender: "@alice:example.org",
        type: "m.poll.start",
        ts: 1,
        content: {
          "m.poll.start": {
            question: { "m.text": "Lunch?" },
            answers: [{ id: "a1", "m.text": "Pizza" }],
          },
        },
      }),
      events: [
        new FakeMatrixEvent({
          roomId: "!room:example.org",
          eventId: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          ts: 2,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        }),
      ],
      nextBatch: null,
      prevBatch: null,
    }));

    const page = await client.getRelations("!room:example.org", "$poll", "m.reference");

    expect(page.originalEvent).toMatchObject({ event_id: "$poll", type: "m.poll.start" });
    expect(page.events).toEqual([
      expect.objectContaining({
        event_id: "$vote",
        type: "m.poll.response",
        sender: "@bob:example.org",
      }),
    ]);
  });

  it("blocks cross-protocol redirects when absolute endpoints are allowed", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://127.0.0.2:8008/next",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("http://127.0.0.1:8008", "token", {
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await expect(
      client.doRequest("GET", "http://127.0.0.1:8008/start", undefined, undefined, {
        allowAbsoluteEndpoint: true,
      }),
    ).rejects.toThrow("Blocked cross-protocol redirect");
  });

  it("strips authorization when redirect crosses origin", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
      });
      if (calls.length === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.2:8008/next" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("http://127.0.0.1:8008", "token", {
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    await client.doRequest("GET", "http://127.0.0.1:8008/start", undefined, undefined, {
      allowAbsoluteEndpoint: true,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8008/start");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(calls[1]?.url).toBe("http://127.0.0.2:8008/next");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
  });

  it("aborts requests after timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_: URL | string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("http://127.0.0.1:8008", "token", {
      localTimeoutMs: 25,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    const pending = client.doRequest("GET", "/_matrix/client/v3/account/whoami");
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(30);

    await assertion;
  });

  it("wires the sync store into the SDK and flushes it on shutdown", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-sdk-store-"));
    const storagePath = path.join(tempDir, "bot-storage.json");

    try {
      const client = new MatrixClient("https://matrix.example.org", "token", {
        storagePath,
      });

      const store = lastCreateClientOpts?.store as { flush: () => Promise<void> } | undefined;
      expect(store).toBeTruthy();
      const flushSpy = vi.spyOn(store!, "flush").mockResolvedValue();

      await client.stopAndPersist();

      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(matrixJsClient.stopClient).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("MatrixClient event bridge", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits room.message only after encrypted events decrypt", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const messageEvents: Array<{ roomId: string; type: string }> = [];

    client.on("room.message", (roomId, event) => {
      messageEvents.push({ roomId, type: event.type });
    });

    await client.start();

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.emit("event", encrypted);
    expect(messageEvents).toHaveLength(0);

    encrypted.emit("decrypted", decrypted);
    // Simulate a second normal event emission from the SDK after decryption.
    matrixJsClient.emit("event", decrypted);
    expect(messageEvents).toEqual([
      {
        roomId: "!room:example.org",
        type: "m.room.message",
      },
    ]);
  });

  it("emits room.failed_decryption when decrypting fails", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const failed: string[] = [];
    const delivered: string[] = [];

    client.on("room.failed_decryption", (_roomId, _event, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    await client.start();

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", decrypted, new Error("decrypt failed"));

    expect(failed).toEqual(["decrypt failed"]);
    expect(delivered).toHaveLength(0);
  });

  it("retries failed decryption and emits room.message after late key availability", async () => {
    vi.useFakeTimers();
    const client = new MatrixClient("https://matrix.example.org", "token");
    const failed: string[] = [];
    const delivered: string[] = [];

    client.on("room.failed_decryption", (_roomId, _event, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
      decryptionFailure: true,
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.emit("decrypted", decrypted);
    });

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    expect(failed).toEqual(["missing room key"]);
    expect(delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_600);

    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(failed).toEqual(["missing room key"]);
    expect(delivered).toEqual(["m.room.message"]);
  });

  it("can drain pending decrypt retries after sync stops", async () => {
    vi.useFakeTimers();
    const client = new MatrixClient("https://matrix.example.org", "token");
    const delivered: string[] = [];

    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
      decryptionFailure: true,
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.emit("decrypted", decrypted);
    });

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    client.stopSyncWithoutPersist();
    await client.drainPendingDecryptions("test shutdown");

    expect(matrixJsClient.stopClient).toHaveBeenCalledTimes(1);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
  });

  it("retries failed decryptions immediately on crypto key update signals", async () => {
    vi.useFakeTimers();
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    const failed: string[] = [];
    const delivered: string[] = [];
    const cryptoListeners = new Map<string, (...args: unknown[]) => void>();

    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        cryptoListeners.set(eventName, listener);
      }),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
    }));

    client.on("room.failed_decryption", (_roomId, _event, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
      decryptionFailure: true,
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.emit("decrypted", decrypted);
    });

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    expect(failed).toEqual(["missing room key"]);
    expect(delivered).toHaveLength(0);

    const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
    expect(trigger).toBeTypeOf("function");
    trigger?.();
    await Promise.resolve();

    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
  });

  it("stops decryption retries after hitting retry cap", async () => {
    vi.useFakeTimers();
    const client = new MatrixClient("https://matrix.example.org", "token");
    const failed: string[] = [];

    client.on("room.failed_decryption", (_roomId, _event, error) => {
      failed.push(error.message);
    });

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
      decryptionFailure: true,
    });

    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      throw new Error("still missing key");
    });

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    expect(failed).toEqual(["missing room key"]);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(8);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(8);
  });

  it("does not start duplicate retries when crypto signals fire while retry is in-flight", async () => {
    vi.useFakeTimers();
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    const delivered: string[] = [];
    const cryptoListeners = new Map<string, (...args: unknown[]) => void>();

    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
        cryptoListeners.set(eventName, listener);
      }),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
    }));

    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
      decryptionFailure: true,
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    const releaseRetryRef: { current?: () => void } = {};
    matrixJsClient.decryptEventIfNeeded = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseRetryRef.current = () => {
            encrypted.emit("decrypted", decrypted);
            resolve();
          };
        }),
    );

    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));

    const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
    expect(trigger).toBeTypeOf("function");
    trigger?.();
    trigger?.();
    await Promise.resolve();

    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    releaseRetryRef.current?.();
    await Promise.resolve();
    expect(delivered).toEqual(["m.room.message"]);
  });

  it("emits room.invite when a membership invite targets the current user", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const invites: string[] = [];

    client.on("room.invite", (roomId) => {
      invites.push(roomId);
    });

    await client.start();

    const inviteMembership = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$invite",
      sender: "@alice:example.org",
      type: "m.room.member",
      ts: Date.now(),
      stateKey: "@bot:example.org",
      content: {
        membership: "invite",
      },
    });

    matrixJsClient.emit("event", inviteMembership);

    expect(invites).toEqual(["!room:example.org"]);
  });

  it("emits room.invite when SDK emits Room event with invite membership", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const invites: string[] = [];
    client.on("room.invite", (roomId) => {
      invites.push(roomId);
    });

    await client.start();

    matrixJsClient.emit("Room", {
      roomId: "!invite:example.org",
      getMyMembership: () => "invite",
    });

    expect(invites).toEqual(["!invite:example.org"]);
  });

  it("waits for a ready sync state before resolving startup", async () => {
    let releaseSyncReady: (() => void) | undefined;
    matrixJsClient.startClient = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSyncReady = () => {
          matrixJsClient.emit("sync", "PREPARED", null, undefined);
          resolve();
        };
      });
    });

    const client = new MatrixClient("https://matrix.example.org", "token");
    let resolved = false;
    const startPromise = client.start().then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      expect(releaseSyncReady).toEqual(expect.any(Function));
    });
    expect(resolved).toBe(false);

    releaseSyncReady?.();
    await startPromise;

    expect(resolved).toBe(true);
  });

  it("rejects startup when sync reports an unexpected error before ready", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      const timer = setTimeout(() => {
        matrixJsClient.emit("sync.unexpectedError", new Error("sync exploded"));
      }, 0);
      timer.unref?.();
    });

    const client = new MatrixClient("https://matrix.example.org", "token");

    await expect(client.start()).rejects.toThrow("sync exploded");
  });

  it("allows transient startup ERROR to recover into PREPARED", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "ERROR", null, new Error("temporary outage"));
        queueMicrotask(() => {
          matrixJsClient.emit("sync", "PREPARED", "ERROR", undefined);
        });
      });
    });

    const client = new MatrixClient("https://matrix.example.org", "token");

    await expect(client.start()).resolves.toBeUndefined();
  });

  it("aborts startup when the readiness wait is canceled", async () => {
    matrixJsClient.startClient = vi.fn(async () => {});

    const abortController = new AbortController();
    const client = new MatrixClient("https://matrix.example.org", "token");
    const startPromise = client.start({ abortSignal: abortController.signal });

    abortController.abort();

    await expect(startPromise).rejects.toMatchObject({
      message: "Matrix startup aborted",
      name: "AbortError",
    });
  });

  it("aborts before post-ready startup work when shutdown races ready sync", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "PREPARED", null, undefined);
      });
    });

    const abortController = new AbortController();
    const client = new MatrixClient("https://matrix.example.org", "token");
    const bootstrapCryptoSpy = vi.spyOn(
      client as unknown as { bootstrapCryptoIfNeeded: () => Promise<void> },
      "bootstrapCryptoIfNeeded",
    );
    bootstrapCryptoSpy.mockImplementation(async () => {});

    client.on("sync.state", (state) => {
      if (state === "PREPARED") {
        abortController.abort();
      }
    });

    await expect(client.start({ abortSignal: abortController.signal })).rejects.toMatchObject({
      message: "Matrix startup aborted",
      name: "AbortError",
    });
    expect(bootstrapCryptoSpy).not.toHaveBeenCalled();
  });

  it("times out startup when no ready sync state arrives", async () => {
    vi.useFakeTimers();
    matrixJsClient.startClient = vi.fn(async () => {});

    const client = new MatrixClient("https://matrix.example.org", "token");
    const startPromise = client.start();
    const startExpectation = expect(startPromise).rejects.toThrow(
      "Matrix client did not reach a ready sync state within 30000ms",
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await startExpectation;
  });

  it("clears stale sync state before a restarted sync session waits for fresh readiness", async () => {
    matrixJsClient.startClient = vi
      .fn(async () => {
        queueMicrotask(() => {
          matrixJsClient.emit("sync", "PREPARED", null, undefined);
        });
      })
      .mockImplementationOnce(async () => {
        queueMicrotask(() => {
          matrixJsClient.emit("sync", "PREPARED", null, undefined);
        });
      })
      .mockImplementationOnce(async () => {});

    const client = new MatrixClient("https://matrix.example.org", "token");

    await client.start();
    client.stopSyncWithoutPersist();

    vi.useFakeTimers();
    const restartPromise = client.start();
    const restartExpectation = expect(restartPromise).rejects.toThrow(
      "Matrix client did not reach a ready sync state within 30000ms",
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await restartExpectation;
  });

  it("replays outstanding invite rooms at startup", async () => {
    matrixJsClient.getRooms = vi.fn(() => [
      {
        roomId: "!pending:example.org",
        getMyMembership: () => "invite",
      },
      {
        roomId: "!joined:example.org",
        getMyMembership: () => "join",
      },
    ]);

    const client = new MatrixClient("https://matrix.example.org", "token");
    const invites: string[] = [];
    client.on("room.invite", (roomId) => {
      invites.push(roomId);
    });

    await client.start();

    expect(invites).toEqual(["!pending:example.org"]);
  });
});

describe("MatrixClient crypto bootstrapping", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes cryptoDatabasePrefix into initRustCrypto", async () => {
    matrixJsClient.getCrypto = vi.fn(() => undefined);

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });

    await client.start();

    expect(matrixJsClient.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: "openclaw-matrix-test",
    });
  });

  it("bootstraps cross-signing with setupNewCrossSigning enabled", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {});
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning,
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });

    await client.start();

    expect(bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({
        authUploadDeviceSigningKeys: expect.any(Function),
      }),
    );
  });

  it("retries bootstrap with forced reset when initial publish/verification is incomplete", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({ on: vi.fn() }));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      password: "secret-password", // pragma: allowlist secret
    });
    const bootstrapSpy = vi
      .fn()
      .mockResolvedValueOnce({
        crossSigningReady: false,
        crossSigningPublished: false,
        ownDeviceVerified: false,
      })
      .mockResolvedValueOnce({
        crossSigningReady: true,
        crossSigningPublished: true,
        ownDeviceVerified: true,
      });
    await (
      client as unknown as {
        ensureCryptoSupportInitialized: () => Promise<void>;
      }
    ).ensureCryptoSupportInitialized();
    (
      client as unknown as {
        cryptoBootstrapper: { bootstrap: typeof bootstrapSpy };
      }
    ).cryptoBootstrapper.bootstrap = bootstrapSpy;

    await client.start();

    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
    expect((bootstrapSpy.mock.calls as unknown[][])[1]?.[1] ?? {}).toEqual({
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
      strict: true,
    });
  });

  it("does not force-reset bootstrap when the device is already signed by its owner", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({ on: vi.fn() }));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      password: "secret-password", // pragma: allowlist secret
    });
    const bootstrapSpy = vi.fn().mockResolvedValue({
      crossSigningReady: false,
      crossSigningPublished: false,
      ownDeviceVerified: true,
    });
    await (
      client as unknown as {
        ensureCryptoSupportInitialized: () => Promise<void>;
      }
    ).ensureCryptoSupportInitialized();
    (
      client as unknown as {
        cryptoBootstrapper: { bootstrap: typeof bootstrapSpy };
      }
    ).cryptoBootstrapper.bootstrap = bootstrapSpy;
    vi.spyOn(client, "getOwnDeviceVerificationStatus").mockResolvedValue({
      encryptionEnabled: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      verified: true,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: true,
      recoveryKeyStored: false,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: null,
      backupVersion: null,
      backup: {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: false,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
    });

    await client.start();

    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
    expect((bootstrapSpy.mock.calls as unknown[][])[0]?.[1] ?? {}).toEqual({
      allowAutomaticCrossSigningReset: false,
    });
  });

  it("attempts repair bootstrap even when no password is configured", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({ on: vi.fn() }));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      // no password — passwordless token-auth bot
    });
    const bootstrapSpy = vi
      .fn()
      .mockResolvedValueOnce({
        crossSigningReady: false,
        crossSigningPublished: false,
        ownDeviceVerified: false,
      })
      .mockResolvedValueOnce({
        crossSigningReady: true,
        crossSigningPublished: true,
        ownDeviceVerified: true,
      });
    await (
      client as unknown as {
        ensureCryptoSupportInitialized: () => Promise<void>;
      }
    ).ensureCryptoSupportInitialized();
    (
      client as unknown as {
        cryptoBootstrapper: { bootstrap: typeof bootstrapSpy };
      }
    ).cryptoBootstrapper.bootstrap = bootstrapSpy;

    await client.start();

    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
    expect((bootstrapSpy.mock.calls as unknown[][])[1]?.[1] ?? {}).toEqual({
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
      strict: true,
    });
  });

  it("catches and logs repair bootstrap failure when UIA is unavailable without password", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({ on: vi.fn() }));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      // no password
    });
    const uiaError = new Error("Interactive auth required");
    const bootstrapSpy = vi
      .fn()
      .mockResolvedValueOnce({
        crossSigningReady: false,
        crossSigningPublished: false,
        ownDeviceVerified: false,
      })
      .mockRejectedValueOnce(uiaError);
    await (
      client as unknown as {
        ensureCryptoSupportInitialized: () => Promise<void>;
      }
    ).ensureCryptoSupportInitialized();
    (
      client as unknown as {
        cryptoBootstrapper: { bootstrap: typeof bootstrapSpy };
      }
    ).cryptoBootstrapper.bootstrap = bootstrapSpy;

    // start() must NOT throw even when the repair bootstrap fails
    await expect(client.start()).resolves.not.toThrow();

    // repair was attempted
    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
  });

  it("provides secret storage callbacks and resolves stored recovery key", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-test-"));
    const recoveryKeyPath = path.join(tmpDir, "recovery-key.json");
    const privateKeyBase64 = Buffer.from([1, 2, 3, 4]).toString("base64");
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "SSSSKEY",
        privateKeyBase64,
      }),
      "utf8",
    );

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      recoveryKeyPath,
    });
    expect(client).toBeInstanceOf(MatrixClient);

    const callbacks = (lastCreateClientOpts?.cryptoCallbacks ?? null) as {
      getSecretStorageKey?: (
        params: { keys: Record<string, unknown> },
        name: string,
      ) => Promise<[string, Uint8Array] | null>;
    } | null;
    expect(callbacks?.getSecretStorageKey).toBeTypeOf("function");

    const resolved = await callbacks?.getSecretStorageKey?.(
      { keys: { SSSSKEY: { algorithm: "m.secret_storage.v1.aes-hmac-sha2" } } },
      "m.cross_signing.master",
    );
    expect(resolved?.[0]).toBe("SSSSKEY");
    expect(Array.from(resolved?.[1] ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("provides a matrix-js-sdk logger to createClient", () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    expect(client).toBeInstanceOf(MatrixClient);
    const logger = (lastCreateClientOpts?.logger ?? null) as {
      debug?: (...args: unknown[]) => void;
      getChild?: (namespace: string) => unknown;
    } | null;
    expect(logger).not.toBeNull();
    expect(logger?.debug).toBeTypeOf("function");
    expect(logger?.getChild).toBeTypeOf("function");
  });

  it("schedules periodic crypto snapshot persistence with fake timers", async () => {
    vi.useFakeTimers();
    const databasesSpy = vi.spyOn(indexedDB, "databases").mockResolvedValue([]);

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      idbSnapshotPath: path.join(os.tmpdir(), "matrix-idb-interval.json"),
      cryptoDatabasePrefix: "openclaw-matrix-interval",
    });

    await client.start();
    const callsAfterStart = databasesSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(databasesSpy.mock.calls.length).toBeGreaterThan(callsAfterStart);
    });

    client.stop();
    const callsAfterStop = databasesSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(databasesSpy.mock.calls.length).toBe(callsAfterStop);
  });

  it("reports own verification status when crypto marks device as verified", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    await client.start();

    const status = await client.getOwnDeviceVerificationStatus();
    expect(status.encryptionEnabled).toBe(true);
    expect(status.verified).toBe(true);
    expect(status.userId).toBe("@bot:example.org");
    expect(status.deviceId).toBe("DEVICE123");
  });

  it("does not treat local-only trust as owner verification", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    await client.start();

    const status = await client.getOwnDeviceVerificationStatus();
    expect(status.localVerified).toBe(true);
    expect(status.crossSigningVerified).toBe(false);
    expect(status.signedByOwner).toBe(false);
    expect(status.verified).toBe(false);
  });

  it("verifies with a provided recovery key and reports success", async () => {
    const encoded = encodeRecoveryKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));
    expect(encoded).toBeTypeOf("string");

    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    const bootstrapSecretStorage = vi.fn(async () => {});
    const bootstrapCrossSigning = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const getSecretStorageStatus = vi.fn(async () => ({
      ready: true,
      defaultKeyId: "SSSSKEY",
      secretStorageKeyValidityMap: { SSSSKEY: true },
    }));
    const getDeviceVerificationStatus = vi.fn(async () => ({
      isVerified: () => true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
    }));
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning,
      bootstrapSecretStorage,
      requestOwnUserVerification: vi.fn(async () => null),
      getSecretStorageStatus,
      getDeviceVerificationStatus,
      checkKeyBackupAndEnable,
    }));

    const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-verify-key-"));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      recoveryKeyPath: path.join(recoveryDir, "recovery-key.json"),
    });

    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.recoveryKeyStored).toBe(true);
    expect(result.deviceId).toBe("DEVICE123");
    expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
    expect(bootstrapSecretStorage).toHaveBeenCalled();
    expect(bootstrapCrossSigning).toHaveBeenCalled();
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
  });

  it("fails recovery-key verification when the device is only locally trusted", async () => {
    const encoded = encodeRecoveryKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));

    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: true,
        defaultKeyId: "SSSSKEY",
        secretStorageKeyValidityMap: { SSSSKEY: true },
      })),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
    }));

    const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-verify-local-only-"));
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      recoveryKeyPath: path.join(recoveryDir, "recovery-key.json"),
    });
    await client.start();

    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toContain("not verified by its owner");
  });

  it("fails recovery-key verification when backup remains untrusted after device verification", async () => {
    const encoded = encodeRecoveryKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));

    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: true,
        defaultKeyId: "SSSSKEY",
        secretStorageKeyValidityMap: { SSSSKEY: true },
      })),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      getActiveSessionBackupVersion: vi.fn(async () => "11"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "11",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: false,
        matchesDecryptionKey: true,
      })),
    }));

    const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-verify-untrusted-"));
    const recoveryKeyPath = path.join(recoveryDir, "recovery-key.json");
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      recoveryKeyPath,
    });

    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result.success).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.error).toContain("backup signature chain is not trusted");
    expect(result.recoveryKeyStored).toBe(false);
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
  });

  it("does not overwrite the stored recovery key when recovery-key verification fails", async () => {
    const previousEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 5)),
    );
    const attemptedEncoded = encodeRecoveryKey(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 55)),
    );

    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {
        throw new Error("secret storage rejected recovery key");
      }),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: true,
        defaultKeyId: "SSSSKEY",
        secretStorageKeyValidityMap: { SSSSKEY: true },
      })),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
    }));

    const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-verify-preserve-"));
    const recoveryKeyPath = path.join(recoveryDir, "recovery-key.json");
    fs.writeFileSync(
      recoveryKeyPath,
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        keyId: "SSSSKEY",
        encodedPrivateKey: previousEncoded,
        privateKeyBase64: Buffer.from(
          new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 5)),
        ).toString("base64"),
      }),
      "utf8",
    );
    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
      recoveryKeyPath,
    });

    const result = await client.verifyWithRecoveryKey(attemptedEncoded as string);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not verified by its owner");
    const persisted = JSON.parse(fs.readFileSync(recoveryKeyPath, "utf8")) as {
      encodedPrivateKey?: string;
    };
    expect(persisted.encodedPrivateKey).toBe(previousEncoded);
  });

  it("reports detailed room-key backup health", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion: vi.fn(async () => "11"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1, 2, 3])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "11",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "11" });

    const status = await client.getOwnDeviceVerificationStatus();
    expect(status.backupVersion).toBe("11");
    expect(status.backup).toEqual({
      serverVersion: "11",
      activeVersion: "11",
      trusted: true,
      matchesDecryptionKey: true,
      decryptionKeyCached: true,
      keyLoadAttempted: false,
      keyLoadError: null,
    });
  });

  it("tries loading backup keys from secret storage when key is missing from cache", async () => {
    const getActiveSessionBackupVersion = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("9");
    const getSessionBackupPrivateKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Uint8Array([1]));
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion,
      getSessionBackupPrivateKey,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "9",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });

    const backup = await client.getRoomKeyBackupStatus();
    expect(backup).toMatchObject({
      serverVersion: "9",
      activeVersion: "9",
      trusted: true,
      matchesDecryptionKey: true,
      decryptionKeyCached: true,
      keyLoadAttempted: true,
      keyLoadError: null,
    });
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
  });

  it("reloads backup keys from secret storage when the cached key mismatches the active backup", async () => {
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const isKeyBackupTrusted = vi
      .fn()
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: false,
      })
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: true,
      });
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion: vi.fn(async () => "49262"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      loadSessionBackupPrivateKeyFromSecretStorage,
      checkKeyBackupAndEnable,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "49262",
      })),
      isKeyBackupTrusted,
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });

    const backup = await client.getRoomKeyBackupStatus();
    expect(backup).toMatchObject({
      serverVersion: "49262",
      activeVersion: "49262",
      trusted: true,
      matchesDecryptionKey: true,
      decryptionKeyCached: true,
      keyLoadAttempted: true,
      keyLoadError: null,
    });
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
  });

  it("reports why backup key loading failed during status checks", async () => {
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {
      throw new Error("secret storage key is not available");
    });
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion: vi.fn(async () => null),
      getSessionBackupPrivateKey: vi.fn(async () => null),
      loadSessionBackupPrivateKeyFromSecretStorage,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "9",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: false,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });

    const backup = await client.getRoomKeyBackupStatus();
    expect(backup.keyLoadAttempted).toBe(true);
    expect(backup.keyLoadError).toContain("secret storage key is not available");
    expect(backup.decryptionKeyCached).toBe(false);
  });

  it("restores room keys from backup after loading key from secret storage", async () => {
    const getActiveSessionBackupVersion = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("9")
      .mockResolvedValue("9");
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const restoreKeyBackup = vi.fn(async () => ({ imported: 4, total: 10 }));
    const crypto = {
      on: vi.fn(),
      getActiveSessionBackupVersion,
      loadSessionBackupPrivateKeyFromSecretStorage,
      checkKeyBackupAndEnable,
      restoreKeyBackup,
      getSessionBackupPrivateKey: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "9",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    };
    matrixJsClient.getCrypto = vi.fn(() => crypto);

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "9" });

    const result = await client.restoreRoomKeyBackup();
    expect(result.success).toBe(true);
    expect(result.backupVersion).toBe("9");
    expect(result.imported).toBe(4);
    expect(result.total).toBe(10);
    expect(result.loadedFromSecretStorage).toBe(true);
    expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
    expect(restoreKeyBackup).toHaveBeenCalledTimes(1);
  });

  it("activates backup after loading the key from secret storage before restore", async () => {
    const getActiveSessionBackupVersion = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("5256")
      .mockResolvedValue("5256");
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const restoreKeyBackup = vi.fn(async () => ({ imported: 0, total: 0 }));
    const crypto = {
      on: vi.fn(),
      getActiveSessionBackupVersion,
      getSessionBackupPrivateKey: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(new Uint8Array([1])),
      loadSessionBackupPrivateKeyFromSecretStorage,
      checkKeyBackupAndEnable,
      restoreKeyBackup,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "5256",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    };
    matrixJsClient.getCrypto = vi.fn(() => crypto);

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "5256" });

    const result = await client.restoreRoomKeyBackup();
    expect(result.success).toBe(true);
    expect(result.backupVersion).toBe("5256");
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
    expect(restoreKeyBackup).toHaveBeenCalledTimes(1);
  });

  it("fails restore when backup key cannot be loaded on this device", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion: vi.fn(async () => null),
      getSessionBackupPrivateKey: vi.fn(async () => null),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "3",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: false,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "3" });

    const result = await client.restoreRoomKeyBackup();
    expect(result.success).toBe(false);
    expect(result.error).toContain("backup decryption key could not be loaded from secret storage");
    expect(result.backupVersion).toBe("3");
    expect(result.backup.matchesDecryptionKey).toBe(false);
  });

  it("reloads the matching backup key before restore when the cached key mismatches", async () => {
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    const restoreKeyBackup = vi.fn(async () => ({ imported: 6, total: 9 }));
    const isKeyBackupTrusted = vi
      .fn()
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: false,
      })
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: true,
      })
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: true,
      });
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      getActiveSessionBackupVersion: vi.fn(async () => "49262"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      loadSessionBackupPrivateKeyFromSecretStorage,
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      restoreKeyBackup,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "49262",
      })),
      isKeyBackupTrusted,
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });

    const result = await client.restoreRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.backupVersion).toBe("49262");
    expect(result.imported).toBe(6);
    expect(result.total).toBe(9);
    expect(result.loadedFromSecretStorage).toBe(true);
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(restoreKeyBackup).toHaveBeenCalledTimes(1);
  });

  it("resets the current room-key backup and creates a fresh trusted version", async () => {
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const bootstrapSecretStorage = vi.fn(async () => {});
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      getActiveSessionBackupVersion: vi.fn(async () => "21869"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "21869",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return { version: "21868" };
      }
      if (method === "DELETE" && endpoint.includes("/room_keys/version/21868")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.previousVersion).toBe("21868");
    expect(result.deletedVersion).toBe("21868");
    expect(result.createdVersion).toBe("21869");
    expect(bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewKeyBackup: true }),
    );
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
  });

  it("reloads the new backup decryption key after reset when the old cached key mismatches", async () => {
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const bootstrapSecretStorage = vi.fn(async () => {});
    const loadSessionBackupPrivateKeyFromSecretStorage = vi.fn(async () => {});
    const isKeyBackupTrusted = vi
      .fn()
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: false,
      })
      .mockResolvedValueOnce({
        trusted: true,
        matchesDecryptionKey: true,
      });
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getActiveSessionBackupVersion: vi.fn(async () => "49262"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "49262",
      })),
      isKeyBackupTrusted,
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return { version: "22245" };
      }
      if (method === "DELETE" && endpoint.includes("/room_keys/version/22245")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.createdVersion).toBe("49262");
    expect(result.backup.matchesDecryptionKey).toBe(true);
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(2);
  });

  it("fails reset when the recreated backup still does not match the local decryption key", async () => {
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage: vi.fn(async () => {}),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      getActiveSessionBackupVersion: vi.fn(async () => "21868"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "21868",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: false,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return { version: "21868" };
      }
      if (method === "DELETE" && endpoint.includes("/room_keys/version/21868")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not have the matching backup decryption key");
    expect(result.createdVersion).toBe("21868");
    expect(result.backup.matchesDecryptionKey).toBe(false);
  });

  it("forces SSSS recreation when backup-secret access fails with bad MAC before reset", async () => {
    // Simulates the state after a cross-signing bootstrap that recreated SSSS but left the
    // old m.megolm_backup.v1 SSSS entry (encrypted with the old key) on the homeserver.
    // The reset preflight now probes backup-secret access directly, so a missing cached
    // key plus a repairable secret-storage load failure should force SSSS recreation.
    const bootstrapSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const loadSessionBackupPrivateKeyFromSecretStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error decrypting secret m.megolm_backup.v1: bad MAC"));
    const getSessionBackupPrivateKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Uint8Array([1]));
    const getSecretStorageStatus = vi.fn(async () => ({
      ready: true,
      defaultKeyId: "key-new",
    }));
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getSessionBackupPrivateKey,
      getSecretStorageStatus,
      getActiveSessionBackupVersion: vi.fn(async () => "22000"),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "22000",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return { version: "21999" };
      }
      if (method === "DELETE" && endpoint.includes("/room_keys/version/21999")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.createdVersion).toBe("22000");
    // bootstrapSecretStorage must have been called with setupNewSecretStorage: true
    // because the pre-reset bad MAC status triggered forceNewSecretStorage.
    expect(bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewKeyBackup: true,
        setupNewSecretStorage: true,
      }),
    );
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
  });

  it("forces SSSS recreation when backup-secret access is broken even without a current server backup", async () => {
    const bootstrapSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const loadSessionBackupPrivateKeyFromSecretStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error decrypting secret m.megolm_backup.v1: bad MAC"));
    const getSessionBackupPrivateKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Uint8Array([1]));
    const getActiveSessionBackupVersion = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("22001");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getActiveSessionBackupVersion,
      getSessionBackupPrivateKey,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "22001",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    const doRequest = vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.previousVersion).toBe(null);
    expect(result.deletedVersion).toBe(null);
    expect(result.createdVersion).toBe("22001");
    expect(bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewKeyBackup: true,
        setupNewSecretStorage: true,
      }),
    );
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(doRequest).not.toHaveBeenCalledWith(
      "DELETE",
      expect.stringContaining("/room_keys/version/"),
    );
  });

  it("forces SSSS recreation when backup-secret access returns a falsey callback error before reset", async () => {
    const bootstrapSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const loadSessionBackupPrivateKeyFromSecretStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error("getSecretStorageKey callback returned falsey"));
    const getSessionBackupPrivateKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Uint8Array([1]));
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getActiveSessionBackupVersion: vi.fn(async () => "22002"),
      getSessionBackupPrivateKey,
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "22002",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (method, endpoint) => {
      if (method === "GET" && endpoint.includes("/room_keys/version")) {
        return { version: "22000" };
      }
      if (method === "DELETE" && endpoint.includes("/room_keys/version/22000")) {
        return {};
      }
      return {};
    });

    const result = await client.resetRoomKeyBackup();

    expect(result.success).toBe(true);
    expect(result.createdVersion).toBe("22002");
    expect(bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({
        setupNewKeyBackup: true,
        setupNewSecretStorage: true,
      }),
    );
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
  });

  it("reports bootstrap failure when cross-signing keys are not published", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: false,
      selfSigningKeyPublished: false,
      userSigningKeyPublished: false,
      published: false,
    });

    const result = await client.bootstrapOwnDeviceVerification();
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
    expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
  });

  it("reports bootstrap success when own device is verified and keys are published", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
      getActiveSessionBackupVersion: vi.fn(async () => "9"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "9",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: true,
      selfSigningKeyPublished: true,
      userSigningKeyPublished: true,
      published: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "9" });

    const result = await client.bootstrapOwnDeviceVerification();
    expect(result.success).toBe(true);
    expect(result.verification.verified).toBe(true);
    expect(result.crossSigning.published).toBe(true);
    expect(result.cryptoBootstrap).not.toBeNull();
  });

  it("reports bootstrap failure when the device is only locally trusted", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: false,
        signedByOwner: false,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: true,
      selfSigningKeyPublished: true,
      userSigningKeyPublished: true,
      published: true,
    });

    const result = await client.bootstrapOwnDeviceVerification();
    expect(result.success).toBe(false);
    expect(result.verification.localVerified).toBe(true);
    expect(result.verification.signedByOwner).toBe(false);
    expect(result.error).toContain("not verified by its owner after bootstrap");
  });

  it("creates a key backup during bootstrap when none exists on the server", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    const bootstrapSecretStorage = vi.fn(async () => {});
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage,
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
      getActiveSessionBackupVersion: vi.fn(async () => "7"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "7",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: true,
      selfSigningKeyPublished: true,
      userSigningKeyPublished: true,
      published: true,
    });
    let backupChecks = 0;
    vi.spyOn(client, "doRequest").mockImplementation(async (_method, endpoint) => {
      if (endpoint.includes("/room_keys/version")) {
        backupChecks += 1;
        return backupChecks >= 2 ? { version: "7" } : {};
      }
      return {};
    });

    const result = await client.bootstrapOwnDeviceVerification();

    expect(result.success).toBe(true);
    expect(result.verification.backupVersion).toBe("7");
    expect(bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewKeyBackup: true }),
    );
  });

  it("does not recreate key backup during bootstrap when one already exists", async () => {
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    const bootstrapSecretStorage = vi.fn(async () => {});
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage,
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
      getActiveSessionBackupVersion: vi.fn(async () => "9"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "9",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: true,
      selfSigningKeyPublished: true,
      userSigningKeyPublished: true,
      published: true,
    });
    vi.spyOn(client, "doRequest").mockImplementation(async (_method, endpoint) => {
      if (endpoint.includes("/room_keys/version")) {
        return { version: "9" };
      }
      return {};
    });

    const result = await client.bootstrapOwnDeviceVerification();

    expect(result.success).toBe(true);
    expect(result.verification.backupVersion).toBe("9");
    const bootstrapSecretStorageCalls = bootstrapSecretStorage.mock.calls as Array<unknown[]>;
    expect(
      bootstrapSecretStorageCalls.some((call) =>
        Boolean((call[0] as { setupNewKeyBackup?: boolean })?.setupNewKeyBackup),
      ),
    ).toBe(false);
  });

  it("does not report bootstrap errors when final verification state is healthy", async () => {
    const encoded = encodeRecoveryKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 90)));
    matrixJsClient.getUserId = vi.fn(() => "@bot:example.org");
    matrixJsClient.getDeviceId = vi.fn(() => "DEVICE123");
    matrixJsClient.getCrypto = vi.fn(() => ({
      on: vi.fn(),
      bootstrapCrossSigning: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      requestOwnUserVerification: vi.fn(async () => null),
      isCrossSigningReady: vi.fn(async () => true),
      userHasCrossSigningKeys: vi.fn(async () => true),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: true,
        defaultKeyId: "SSSSKEY",
        secretStorageKeyValidityMap: { SSSSKEY: true },
      })),
      getDeviceVerificationStatus: vi.fn(async () => ({
        isVerified: () => true,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      })),
      getActiveSessionBackupVersion: vi.fn(async () => "12"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getKeyBackupInfo: vi.fn(async () => ({
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: {},
        version: "12",
      })),
      isKeyBackupTrusted: vi.fn(async () => ({
        trusted: true,
        matchesDecryptionKey: true,
      })),
    }));

    const client = new MatrixClient("https://matrix.example.org", "token", {
      encryption: true,
    });
    vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
      userId: "@bot:example.org",
      masterKeyPublished: true,
      selfSigningKeyPublished: true,
      userSigningKeyPublished: true,
      published: true,
    });
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "12" });

    const result = await client.bootstrapOwnDeviceVerification({
      recoveryKey: encoded as string,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
