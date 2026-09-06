import { createHmac } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  FaceTimeHelperActionError,
  FaceTimeHelperSocketServer,
  FaceTimeHelperUnavailableError,
} from "../src/helper-rpc.js";

const TEST_HELPER_AUTH_TOKEN = "a".repeat(64);
const TEST_HELPER_BUILD_ID = "b".repeat(64);

type TestHelperSession = {
  connectionEpoch: string;
  connectionKey: string;
  incomingSequence: number;
  outgoingSequence: number;
};

const helperSessions = new WeakMap<net.Socket, TestHelperSession>();

function hmac(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

function readFrame(socket: net.Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => {
      try {
        resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function waitForSocketEvent(socket: net.Socket, event: "close" | "connect"): Promise<void> {
  return new Promise((resolve) => {
    socket.once(event, () => resolve());
  });
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function readHelperPayload(socket: net.Socket): Promise<Record<string, unknown>> {
  const session = helperSessions.get(socket);
  if (!session) {
    throw new Error("test helper is not authenticated");
  }
  const envelope = await readFrame(socket);
  const sequence = Number(envelope.sequence);
  const payloadJson = String(envelope.payload_json);
  expect(envelope).toMatchObject({
    connection_epoch: session.connectionEpoch,
    direction: "server-to-helper",
    sequence: session.incomingSequence + 1,
  });
  expect(envelope.auth).toBe(
    hmac(
      session.connectionKey,
      `message\nserver-to-helper\n${session.connectionEpoch}\n${sequence}\n${payloadJson}`,
    ),
  );
  session.incomingSequence = sequence;
  return JSON.parse(payloadJson) as Record<string, unknown>;
}

function encodeHelperPayload(socket: net.Socket, payload: Record<string, unknown>): string {
  const session = helperSessions.get(socket);
  if (!session) {
    throw new Error("test helper is not authenticated");
  }
  const sequence = session.outgoingSequence + 1;
  const payloadJson = JSON.stringify(payload);
  session.outgoingSequence = sequence;
  return `${JSON.stringify({
    connection_epoch: session.connectionEpoch,
    sequence,
    direction: "helper-to-server",
    payload_json: payloadJson,
    auth: hmac(
      session.connectionKey,
      `message\nhelper-to-server\n${session.connectionEpoch}\n${sequence}\n${payloadJson}`,
    ),
  })}\r\n`;
}

function sendHelperPayload(socket: net.Socket, payload: Record<string, unknown>): void {
  socket.write(encodeHelperPayload(socket, payload));
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve TCP port");
  }
  return address.port;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for condition");
}

async function registerHelper(
  socket: net.Socket,
  helper: FaceTimeHelperSocketServer,
  bundleIdentifier: string,
  buildId: string | null = TEST_HELPER_BUILD_ID,
  expectConnected = true,
): Promise<TestHelperSession | undefined> {
  if (buildId === null) {
    socket.write(`${JSON.stringify({ event: "ping", bundle_identifier: bundleIdentifier })}\r\n`);
    return undefined;
  }
  const processId = 1234;
  const processStartedAtMs = 1_700_000_000_000;
  const clientNonce = "c".repeat(64);
  socket.write(
    `${JSON.stringify({
      event: "client-hello",
      bundle_identifier: bundleIdentifier,
      build_id: buildId,
      process_id: processId,
      process_started_at_ms: processStartedAtMs,
      client_nonce: clientNonce,
      proof: hmac(
        TEST_HELPER_AUTH_TOKEN,
        `client-hello\n${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}`,
      ),
    })}\r\n`,
  );
  if (!expectConnected) {
    return undefined;
  }
  const serverHello = await readFrame(socket);
  const serverNonce = String(serverHello.server_nonce);
  const connectionEpoch = String(serverHello.connection_epoch);
  const context = `${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}\n${serverNonce}\n${connectionEpoch}`;
  expect(serverHello).toMatchObject({
    event: "server-hello",
    client_nonce: clientNonce,
    proof: hmac(TEST_HELPER_AUTH_TOKEN, `server-hello\n${context}`),
  });
  const connectionKey = hmac(TEST_HELPER_AUTH_TOKEN, `session\n${context}`);
  socket.write(
    `${JSON.stringify({
      event: "client-finish",
      connection_epoch: connectionEpoch,
      proof: hmac(connectionKey, `client-finish\n${connectionEpoch}`),
    })}\r\n`,
  );
  const session = {
    connectionEpoch,
    connectionKey,
    incomingSequence: 0,
    outgoingSequence: 0,
  };
  helperSessions.set(socket, session);
  await expect(readHelperPayload(socket)).resolves.toEqual({ event: "session-ready" });
  expect(helper.connectedHelperBundles).not.toContain(bundleIdentifier);
  sendHelperPayload(socket, { event: "session-ready-ack" });
  await waitFor(() => helper.connectedHelperBundles.includes(bundleIdentifier));
  return session;
}

describe("FaceTime helper RPC", () => {
  let helper: FaceTimeHelperSocketServer | undefined;
  let client: net.Socket | undefined;

  afterEach(async () => {
    client?.destroy();
    await helper?.stop();
    client = undefined;
    helper = undefined;
  });

  it("sends set-muted actions over newline-framed JSON and resolves acknowledgements", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);

    const actionPromise = helper.setMuted("call-1", false);
    const payload = await received;
    expect(payload).toMatchObject({
      action: "set-muted",
      data: { callUUID: "call-1", muted: false },
    });
    expect(typeof payload.transactionId).toBe("string");

    sendHelperPayload(client, {
      transactionId: payload.transactionId,
      conversation_audio_started: true,
    });
    await expect(actionPromise).resolves.toMatchObject({
      transactionId: payload.transactionId,
      conversation_audio_started: true,
    });
  });

  it("sends leave-call actions over newline-framed JSON", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);

    const actionPromise = helper.leaveCall("call-2");
    const payload = await received;
    expect(payload).toMatchObject({
      action: "leave-call",
      data: { callUUID: "call-2" },
    });

    sendHelperPayload(client, { transactionId: payload.transactionId });
    await expect(actionPromise).resolves.toMatchObject({
      transactionId: payload.transactionId,
    });
  });

  it.each([
    ["answerCall", "answer-call"],
    ["leaveCall", "leave-call"],
  ] as const)("fans %s out to FaceTime and Phone helpers", async (method, action) => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    client = faceTimeClient;
    const phoneClient = net.createConnection({ host: "127.0.0.1", port });
    faceTimeClient.setEncoding("utf8");
    phoneClient.setEncoding("utf8");
    await Promise.all([
      waitForSocketEvent(faceTimeClient, "connect"),
      waitForSocketEvent(phoneClient, "connect"),
    ]);
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");
    await registerHelper(phoneClient, helper, "com.apple.mobilephone");

    const payloadsPromise = Promise.all([
      readHelperPayload(faceTimeClient),
      readHelperPayload(phoneClient),
    ]);
    const actionPromise = helper[method]("call-phone");
    const [faceTimePayload, phonePayload] = await payloadsPromise;
    expect(faceTimePayload).toMatchObject({
      action,
      data: { callUUID: "call-phone" },
    });
    expect(phonePayload).toMatchObject({
      action,
      data: { callUUID: "call-phone" },
    });

    sendHelperPayload(faceTimeClient, {
      transactionId: faceTimePayload.transactionId,
      error: "call not found",
    });
    sendHelperPayload(phoneClient, {
      transactionId: phonePayload.transactionId,
      handled: true,
    });

    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 2,
      helperResults: [expect.objectContaining({ handled: true })],
      handled: true,
    });
  });

  it("sends start-call actions with an explicit handle and mode", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);

    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "video" },
      "dial-1",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    expect(payload.action).toBe("start-call");
    expect(payload.data).toEqual({
      handle: "owner@example.com",
      mode: "video",
      dialID: "dial-1",
      requestedAt: "2026-07-20T17:52:00.000Z",
    });

    sendHelperPayload(client, { transactionId: payload.transactionId, call_uuid: "call-3" });
    await expect(actionPromise).resolves.toMatchObject({ call_uuid: "call-3" });
  });

  it("distinguishes definitive helper rejection from transport failure", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);
    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "audio" },
      "dial-2",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    sendHelperPayload(client, { transactionId: payload.transactionId, error: "cannot dial" });

    await expect(actionPromise).rejects.toBeInstanceOf(FaceTimeHelperActionError);
  });

  it("preserves helper-declared ambiguous dial outcomes", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);
    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "audio" },
      "dial-3",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    sendHelperPayload(client, {
      transactionId: payload.transactionId,
      error: "dial outcome is unknown",
      ambiguous: true,
      proxy_identifier: "proxy-3",
    });

    await expect(actionPromise).rejects.toMatchObject({
      name: "FaceTimeHelperAmbiguousError",
      result: { proxy_identifier: "proxy-3" },
    });
  });

  it("routes outbound calls to FaceTime regardless of helper connection order", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    const phoneClient = net.createConnection({ host: "127.0.0.1", port });
    client = phoneClient;
    phoneClient.setEncoding("utf8");
    await waitForSocketEvent(phoneClient, "connect");
    await registerHelper(phoneClient, helper, "com.apple.mobilephone");
    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    faceTimeClient.setEncoding("utf8");
    await waitForSocketEvent(faceTimeClient, "connect");
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");

    let phoneReceivedAction = false;
    phoneClient.on("data", () => {
      phoneReceivedAction = true;
    });
    const received = readHelperPayload(faceTimeClient);

    const actionPromise = helper.startCall(
      { handle: "owner@example.com", mode: "video" },
      "dial-routed",
      "2026-07-20T17:52:00.000Z",
    );
    const payload = await received;
    sendHelperPayload(faceTimeClient, {
      transactionId: payload.transactionId,
      call_uuid: "call-routed",
    });

    await expect(actionPromise).resolves.toMatchObject({ call_uuid: "call-routed" });
    expect(phoneReceivedAction).toBe(false);
    faceTimeClient.destroy();
  });

  it("reports a dial as definitely unsent when no helper is connected", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    await expect(
      helper.startCall(
        { handle: "owner@example.com", mode: "audio" },
        "dial-4",
        "2026-07-20T17:52:00.000Z",
      ),
    ).rejects.toBeInstanceOf(FaceTimeHelperUnavailableError);
  });

  it("rejects an authenticated stale helper and reports its process", async () => {
    const port = await reservePort();
    let staleHelper: { bundleIdentifier: string; processId: number } | undefined;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onStale: (bundleIdentifier, processId) => {
        staleHelper = { bundleIdentifier, processId };
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime", "c".repeat(64), false);
    await waitFor(() => Boolean(staleHelper));

    expect(staleHelper).toEqual({
      bundleIdentifier: "com.apple.FaceTime",
      processId: 1234,
    });
    expect(helper.connectedSockets).toBe(0);
  });

  it("rejects the retired pre-build-id authentication shape", async () => {
    const port = await reservePort();
    let staleReported = false;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onStale: (bundleIdentifier, processId) => {
        void bundleIdentifier;
        void processId;
        staleReported = true;
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime", null, false);
    await nextImmediate();
    expect(staleReported).toBe(false);
    expect(helper.connectedSockets).toBe(0);
  });

  it("queries the helper for an outgoing call by handle", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);
    const actionPromise = helper.findOutgoingCall("owner@example.com");
    const payload = await received;
    expect(payload).toMatchObject({
      action: "find-outgoing-call",
      data: { handle: "owner@example.com" },
    });
    sendHelperPayload(client, {
      transactionId: payload.transactionId,
      found: true,
      call_uuid: "call-4",
    });
    await expect(actionPromise).resolves.toMatchObject({ found: true, call_uuid: "call-4" });
  });

  it("queries the helper for a known outgoing call UUID", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);
    const actionPromise = helper.findOutgoingCall(
      "owner@example.com",
      "call-3",
      "dial-5",
      "proxy-3",
    );
    const payload = await received;
    expect(payload).toMatchObject({
      action: "find-outgoing-call",
      data: {
        handle: "owner@example.com",
        callUUID: "call-3",
        dialID: "dial-5",
        proxyIdentifier: "proxy-3",
      },
    });
    sendHelperPayload(client, {
      transactionId: payload.transactionId,
      found: true,
      call_uuid: "call-3",
    });
    await expect(actionPromise).resolves.toMatchObject({ found: true, call_uuid: "call-3" });
  });

  it("cancels an accepted outgoing call by its caller-generated dial ID", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const received = readHelperPayload(client);
    const actionPromise = helper.cancelOutgoingCall({
      dialID: "dial-6",
      handle: "owner@example.com",
      proxyIdentifier: "proxy-6",
    });
    const payload = await received;
    expect(payload).toMatchObject({
      action: "cancel-outgoing-call",
      data: {
        dialID: "dial-6",
        handle: "owner@example.com",
        proxyIdentifier: "proxy-6",
      },
    });
    sendHelperPayload(client, {
      transactionId: payload.transactionId,
      found: true,
      cancelled: true,
    });
    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 1,
      helperResults: [expect.objectContaining({ cancelled: true })],
    });
  });

  it("excludes unauthenticated sockets from call-control fanout", async () => {
    const port = await reservePort();
    let injectedEvents = 0;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => {
        injectedEvents += 1;
      },
    });
    await helper.start();

    const faceTimeClient = net.createConnection({ host: "127.0.0.1", port });
    client = faceTimeClient;
    faceTimeClient.setEncoding("utf8");
    await waitForSocketEvent(faceTimeClient, "connect");
    await registerHelper(faceTimeClient, helper, "com.apple.FaceTime");
    const rogueClient = net.createConnection({ host: "127.0.0.1", port });
    rogueClient.setEncoding("utf8");
    await waitForSocketEvent(rogueClient, "connect");
    rogueClient.write(
      `${JSON.stringify({
        event: "ft-call-status-changed",
        data: { call_uuid: "forged-call", call_status: 1 },
      })}\r\n`,
    );
    await nextImmediate();
    expect(injectedEvents).toBe(0);

    let rogueReceivedAction = false;
    rogueClient.on("data", () => {
      rogueReceivedAction = true;
    });
    const received = readHelperPayload(faceTimeClient);

    const actionPromise = helper.cancelOutgoingCall({
      dialID: "dial-authenticated",
      handle: "owner@example.com",
      callUUID: "call-authenticated",
    });
    const payload = await received;
    sendHelperPayload(faceTimeClient, {
      transactionId: payload.transactionId,
      cancelled: true,
    });

    await expect(actionPromise).resolves.toMatchObject({
      helpersContacted: 1,
      cancelled: true,
    });
    expect(rogueReceivedAction).toBe(false);
    rogueClient.destroy();
  });

  it("delivers a signed helper event once and closes the connection on replay", async () => {
    const port = await reservePort();
    const events: unknown[] = [];
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: (message) => events.push(message),
    });
    await helper.start();
    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");

    const envelope = encodeHelperPayload(client, {
      event: "ft-call-status-changed",
      data: { call_uuid: "call-once" },
    });
    const closed = waitForSocketEvent(client, "close");
    client.write(envelope);
    await waitFor(() => events.length === 1);
    client.write(envelope);
    await closed;

    expect(events).toEqual([{ event: "ft-call-status-changed", data: { call_uuid: "call-once" } }]);
  });

  it("notifies when the last helper socket disconnects", async () => {
    const port = await reservePort();
    let disconnects = 0;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
      onDisconnect: () => {
        disconnects += 1;
      },
    });
    await helper.start();

    client = net.createConnection({ host: "127.0.0.1", port });
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");
    await waitFor(() => helper?.connectedSockets === 1);

    client.destroy();
    await waitFor(() => disconnects === 1);
    expect(helper.connectedSockets).toBe(0);
  });

  it.each([
    { name: "complete", payload: `${"x".repeat(64 * 1024 + 1)}\n` },
    { name: "incomplete", payload: "x".repeat(64 * 1024 + 1) },
  ])("closes an oversized $name helper frame before parsing", async ({ payload }) => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => {
        throw new Error("oversized input reached the message boundary");
      },
    });
    await helper.start();
    client = net.createConnection({ host: "127.0.0.1", port });
    await waitForSocketEvent(client, "connect");
    const closed = waitForSocketEvent(client, "close");
    client.write(payload);
    await closed;
    expect(helper.connectedSockets).toBe(0);
  });

  it("closes a byte-dripping unauthenticated helper socket at the absolute deadline", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();
    client = net.createConnection({ host: "127.0.0.1", port });
    await waitForSocketEvent(client, "connect");
    const closed = waitForSocketEvent(client, "close");
    const drip = setInterval(() => client?.write(" "), 250);
    await closed;
    clearInterval(drip);
    expect(helper.connectedSockets).toBe(0);
  }, 5_000);

  it("attaches the authenticated carrier process identity to every helper event", async () => {
    const port = await reservePort();
    let observedPeer: { bundleIdentifier: string; processId: number } | undefined;
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: (_message, peer) => {
        observedPeer = peer;
      },
    });
    await helper.start();
    client = net.createConnection({ host: "127.0.0.1", port });
    client.setEncoding("utf8");
    await waitForSocketEvent(client, "connect");
    await registerHelper(client, helper, "com.apple.FaceTime");
    sendHelperPayload(client, { event: "ft-call-status-changed", data: {} });
    await waitFor(() => observedPeer !== undefined);
    expect(observedPeer).toMatchObject({
      bundleIdentifier: "com.apple.FaceTime",
      processId: 1234,
    });
  });

  it("rejects helper connections beyond the bounded socket set", async () => {
    const port = await reservePort();
    helper = new FaceTimeHelperSocketServer({
      host: "127.0.0.1",
      port,
      logger: console,
      ipcKey: TEST_HELPER_AUTH_TOKEN,
      buildId: TEST_HELPER_BUILD_ID,
      onMessage: () => undefined,
    });
    await helper.start();
    const sockets: net.Socket[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        sockets.push(socket);
        await waitForSocketEvent(socket, "connect");
      }
      const overflow = net.createConnection({ host: "127.0.0.1", port });
      sockets.push(overflow);
      await waitForSocketEvent(overflow, "connect");
      await waitForSocketEvent(overflow, "close");
      expect(overflow.destroyed).toBe(true);
    } finally {
      sockets.forEach((socket) => socket.destroy());
    }
  });
});
