import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FaceTimeDialRequest } from "./outbound-call.js";

type HelperSocketServerParams = {
  host: string;
  port: number;
  logger: RuntimeLogger;
  ipcKey: string;
  buildId: string;
  onMessage: (message: unknown, peer: FaceTimeHelperPeer) => void;
  onConnect?: (bundleIdentifier: string) => void;
  onDisconnect?: (bundleIdentifier: string) => void;
  onStale?: (bundleIdentifier: string, processId: number) => void;
};

export type HelperActionResult = Record<string, unknown>;

type FaceTimeNativeActionOutcome =
  | { status: "answered-muted" }
  | { status: "safe-muted" }
  | { status: "media-active" }
  | { status: "termination-requested" }
  | { status: "absent" };

export type FaceTimeHelperPeer = {
  bundleIdentifier: string;
  processId: number;
  processStartedAtMs: number;
  connectionGeneration: number;
};

const FACETIME_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);
const FACETIME_HELPER_BUNDLES = new Set([
  ...FACETIME_DIAL_HELPER_BUNDLES,
  "com.apple.mobilephone",
  "com.apple.TelephonyUtilities",
]);
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 8;
const MAX_PENDING_ACTIONS = 32;
const AUTH_DEADLINE_MS = 3_000;

function helperHmac(ipcKey: string, message: string): string {
  return createHmac("sha256", ipcKey).update(message).digest("hex");
}

function secureStringsEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return (
    firstBuffer.length > 0 &&
    firstBuffer.length === secondBuffer.length &&
    timingSafeEqual(firstBuffer, secondBuffer)
  );
}

export class FaceTimeHelperActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperActionError";
  }
}

export class FaceTimeHelperAmbiguousError extends Error {
  constructor(
    message: string,
    readonly result: HelperActionResult = {},
  ) {
    super(message);
    this.name = "FaceTimeHelperAmbiguousError";
  }
}

export class FaceTimeHelperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceTimeHelperUnavailableError";
  }
}

type PendingRpc = {
  resolve: (result: HelperActionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingHelperHandshake = {
  bundleIdentifier: string;
  processId: number;
  processStartedAtMs: number;
  clientNonce: string;
  serverNonce: string;
  connectionEpoch: string;
  connectionKey: string;
};

type HelperAuthSession = PendingHelperHandshake & {
  incomingSequence: number;
  outgoingSequence: number;
};

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export class FaceTimeHelperSocketServer {
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #socketPeers = new Map<net.Socket, FaceTimeHelperPeer>();
  readonly #pendingHandshakes = new Map<net.Socket, PendingHelperHandshake>();
  readonly #socketAuthSessions = new Map<net.Socket, HelperAuthSession>();
  readonly #authDeadlineTimers = new Map<net.Socket, ReturnType<typeof setTimeout>>();
  readonly #pending = new Map<string, PendingRpc>();
  readonly #logger: RuntimeLogger;
  #started = false;
  #connectionGeneration = 0;

  constructor(private readonly params: HelperSocketServerParams) {
    this.#logger = params.logger;
    this.#server = net.createServer((socket) => this.#handleSocket(socket));
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.params.port, this.params.host);
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("helper socket server stopped"));
    }
    this.#pending.clear();
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    for (const deadline of this.#authDeadlineTimers.values()) {
      clearTimeout(deadline);
    }
    this.#authDeadlineTimers.clear();
    if (!this.#started) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    this.#started = false;
  }

  async answerCall(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("answer-call", { callUUID });
  }

  async startCall(
    request: FaceTimeDialRequest,
    dialID: string,
    requestedAt: string,
  ): Promise<HelperActionResult> {
    return await this.#sendAction("start-call", { ...request, dialID, requestedAt });
  }

  async findOutgoingCall(
    handle: string,
    callUUID?: string,
    dialID?: string,
    proxyIdentifier?: string,
    requestedAt?: string,
    mode?: FaceTimeDialRequest["mode"],
  ): Promise<HelperActionResult> {
    return await this.#sendActionToAll("find-outgoing-call", {
      handle,
      ...(callUUID ? { callUUID } : {}),
      ...(dialID ? { dialID } : {}),
      ...(proxyIdentifier ? { proxyIdentifier } : {}),
      ...(requestedAt ? { requestedAt } : {}),
      ...(mode ? { mode } : {}),
    });
  }

  async cancelOutgoingCall(params: {
    dialID: string;
    handle: string;
    callUUID?: string;
    proxyIdentifier?: string;
    requestedAt?: string;
    mode?: FaceTimeDialRequest["mode"];
  }): Promise<HelperActionResult> {
    return await this.#sendActionToAll("cancel-outgoing-call", params);
  }

  async leaveCall(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("leave-call", { callUUID }, 750);
  }

  async safetyMute(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("safety-mute", { callUUID }, 750);
  }

  async setMuted(callUUID: string, muted: boolean): Promise<HelperActionResult> {
    return await this.#sendActionToAll("set-muted", { callUUID, muted });
  }

  async startTransmission(callUUID: string): Promise<HelperActionResult> {
    return await this.#sendActionToAll("start-transmission", { callUUID });
  }

  async inspectCall(callUUIDs: readonly string[]): Promise<HelperActionResult> {
    return await this.#sendActionToAll("inspect-call", { callUUIDs }, 750);
  }

  get connectedSockets(): number {
    return this.#socketPeers.size;
  }

  get connectedHelperBundles(): string[] {
    return [...new Set([...this.#socketPeers.values()].map((peer) => peer.bundleIdentifier))];
  }

  #handleSocket(socket: net.Socket): void {
    if (this.#sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    const authDeadline = setTimeout(() => {
      if (!this.#socketPeers.has(socket)) {
        socket.destroy();
      }
    }, AUTH_DEADLINE_MS);
    authDeadline.unref?.();
    this.#authDeadlineTimers.set(socket, authDeadline);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const newline = buffer.search(/\r?\n/);
        if (newline < 0) {
          if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
            socket.destroy();
          }
          break;
        }
        if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line) {
          this.#handleLine(socket, line);
        }
      }
    });
    socket.on("error", (error) => {
      this.#logger.debug?.(`[facetime] helper socket error: ${formatErrorMessage(error)}`);
    });
    socket.on("close", () => {
      const disconnectedBundle = this.#socketPeers.get(socket)?.bundleIdentifier;
      if (disconnectedBundle) {
        this.#connectionGeneration += 1;
      }
      this.#sockets.delete(socket);
      this.#socketPeers.delete(socket);
      this.#pendingHandshakes.delete(socket);
      this.#socketAuthSessions.delete(socket);
      const deadline = this.#authDeadlineTimers.get(socket);
      if (deadline) {
        clearTimeout(deadline);
        this.#authDeadlineTimers.delete(socket);
      }
      if (disconnectedBundle) {
        this.params.onDisconnect?.(disconnectedBundle);
      }
    });
  }

  #handleLine(socket: net.Socket, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#logger.debug?.(`[facetime] rejected invalid helper JSON: ${formatErrorMessage(error)}`);
      socket.destroy();
      return;
    }
    const record = asRecord(parsed);
    if (record.event === "client-hello") {
      this.#handleClientHello(socket, record);
      return;
    }
    if (record.event === "client-finish") {
      this.#handleClientFinish(socket, record);
      return;
    }

    const payload = this.#consumeHelperEnvelope(socket, record);
    if (!payload) {
      this.#logger.warn?.("[facetime] rejected unauthenticated or replayed helper message");
      socket.destroy();
      return;
    }
    if (!this.#socketPeers.has(socket)) {
      if (hasExactKeys(payload, ["event"]) && payload.event === "session-ready-ack") {
        this.#admitAuthenticatedHelper(socket);
        return;
      }
      socket.destroy();
      return;
    }

    const transactionId = typeof payload.transactionId === "string" ? payload.transactionId : "";
    if (transactionId && this.#pending.has(transactionId)) {
      const pending = this.#pending.get(transactionId);
      this.#pending.delete(transactionId);
      if (pending) {
        clearTimeout(pending.timeout);
        if (typeof payload.error === "string" && payload.error) {
          pending.reject(
            payload.ambiguous === true
              ? new FaceTimeHelperAmbiguousError(payload.error, payload)
              : new FaceTimeHelperActionError(payload.error),
          );
        } else {
          pending.resolve(payload);
        }
      }
      return;
    }
    const peer = this.#socketPeers.get(socket);
    if (peer) {
      this.params.onMessage(payload, peer);
    }
  }

  #handleClientHello(socket: net.Socket, record: Record<string, unknown>): void {
    if (
      this.#pendingHandshakes.has(socket) ||
      this.#socketAuthSessions.has(socket) ||
      !hasExactKeys(record, [
        "event",
        "bundle_identifier",
        "build_id",
        "process_id",
        "process_started_at_ms",
        "client_nonce",
        "proof",
      ])
    ) {
      socket.destroy();
      return;
    }
    const bundleIdentifier =
      typeof record.bundle_identifier === "string" ? record.bundle_identifier.trim() : "";
    const buildId = typeof record.build_id === "string" ? record.build_id.trim() : "";
    const processId =
      typeof record.process_id === "number" && Number.isSafeInteger(record.process_id)
        ? record.process_id
        : 0;
    const processStartedAtMs =
      typeof record.process_started_at_ms === "number" &&
      Number.isSafeInteger(record.process_started_at_ms)
        ? record.process_started_at_ms
        : 0;
    const clientNonce = typeof record.client_nonce === "string" ? record.client_nonce : "";
    const proof = typeof record.proof === "string" ? record.proof : "";
    const expectedProof = helperHmac(
      this.params.ipcKey,
      `client-hello\n${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}`,
    );
    if (
      !FACETIME_HELPER_BUNDLES.has(bundleIdentifier) ||
      processId <= 0 ||
      processStartedAtMs <= 0 ||
      clientNonce.length < 32 ||
      !secureStringsEqual(proof, expectedProof)
    ) {
      socket.destroy();
      return;
    }
    if (buildId !== this.params.buildId) {
      this.params.onStale?.(bundleIdentifier, processId);
      socket.destroy();
      return;
    }
    const serverNonce = randomUUID();
    const connectionEpoch = randomUUID();
    const context = `${bundleIdentifier}\n${buildId}\n${processId}\n${processStartedAtMs}\n${clientNonce}\n${serverNonce}\n${connectionEpoch}`;
    const handshake: PendingHelperHandshake = {
      bundleIdentifier,
      processId,
      processStartedAtMs,
      clientNonce,
      serverNonce,
      connectionEpoch,
      connectionKey: helperHmac(this.params.ipcKey, `session\n${context}`),
    };
    this.#pendingHandshakes.set(socket, handshake);
    socket.write(
      `${JSON.stringify({
        event: "server-hello",
        client_nonce: clientNonce,
        server_nonce: serverNonce,
        connection_epoch: connectionEpoch,
        proof: helperHmac(this.params.ipcKey, `server-hello\n${context}`),
      })}\r\n`,
    );
  }

  #handleClientFinish(socket: net.Socket, record: Record<string, unknown>): void {
    const handshake = this.#pendingHandshakes.get(socket);
    if (
      !handshake ||
      !hasExactKeys(record, ["event", "connection_epoch", "proof"]) ||
      record.connection_epoch !== handshake.connectionEpoch ||
      typeof record.proof !== "string" ||
      !secureStringsEqual(
        record.proof,
        helperHmac(handshake.connectionKey, `client-finish\n${handshake.connectionEpoch}`),
      )
    ) {
      socket.destroy();
      return;
    }
    this.#pendingHandshakes.delete(socket);
    this.#socketAuthSessions.set(socket, {
      ...handshake,
      incomingSequence: 0,
      outgoingSequence: 0,
    });
    this.#writeServerPayload(socket, { event: "session-ready" });
  }

  #admitAuthenticatedHelper(socket: net.Socket): void {
    const session = this.#socketAuthSessions.get(socket);
    if (!session) {
      socket.destroy();
      return;
    }
    this.#socketPeers.set(socket, {
      bundleIdentifier: session.bundleIdentifier,
      processId: session.processId,
      processStartedAtMs: session.processStartedAtMs,
      connectionGeneration: ++this.#connectionGeneration,
    });
    const deadline = this.#authDeadlineTimers.get(socket);
    if (deadline) {
      clearTimeout(deadline);
      this.#authDeadlineTimers.delete(socket);
    }
    this.params.onConnect?.(session.bundleIdentifier);
  }

  #consumeHelperEnvelope(
    socket: net.Socket,
    record: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const session = this.#socketAuthSessions.get(socket);
    if (
      !session ||
      !hasExactKeys(record, [
        "connection_epoch",
        "sequence",
        "direction",
        "payload_json",
        "auth",
      ]) ||
      record.connection_epoch !== session.connectionEpoch ||
      record.direction !== "helper-to-server" ||
      typeof record.sequence !== "number" ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence !== session.incomingSequence + 1 ||
      typeof record.payload_json !== "string" ||
      typeof record.auth !== "string"
    ) {
      return undefined;
    }
    const expectedAuth = helperHmac(
      session.connectionKey,
      `message\nhelper-to-server\n${session.connectionEpoch}\n${record.sequence}\n${record.payload_json}`,
    );
    if (!secureStringsEqual(record.auth, expectedAuth)) {
      return undefined;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(record.payload_json);
    } catch {
      return undefined;
    }
    const payloadRecord = asRecord(payload);
    if (Object.keys(payloadRecord).length === 0) {
      return undefined;
    }
    session.incomingSequence = record.sequence;
    return payloadRecord;
  }

  #writeServerPayload(socket: net.Socket, payload: Record<string, unknown>): string {
    const session = this.#socketAuthSessions.get(socket);
    if (!session) {
      throw new FaceTimeHelperUnavailableError("FaceTime helper socket is not authenticated");
    }
    const payloadJson = JSON.stringify(payload);
    const sequence = session.outgoingSequence + 1;
    const envelope = JSON.stringify({
      connection_epoch: session.connectionEpoch,
      sequence,
      direction: "server-to-helper",
      payload_json: payloadJson,
      auth: helperHmac(
        session.connectionKey,
        `message\nserver-to-helper\n${session.connectionEpoch}\n${sequence}\n${payloadJson}`,
      ),
    });
    if (Buffer.byteLength(envelope) > MAX_FRAME_BYTES) {
      throw new FaceTimeHelperActionError("FaceTime helper message exceeds the frame limit");
    }
    session.outgoingSequence = sequence;
    socket.write(`${envelope}\r\n`);
    return envelope;
  }

  async #sendAction(action: string, data: Record<string, unknown>): Promise<HelperActionResult> {
    const socket = [...this.#sockets].find(
      (candidate) =>
        !candidate.destroyed &&
        FACETIME_DIAL_HELPER_BUNDLES.has(this.#socketPeers.get(candidate)?.bundleIdentifier ?? ""),
    );
    if (!socket) {
      throw new FaceTimeHelperUnavailableError(
        "Authenticated FaceTime dialing helper is not connected to the facetime event socket",
      );
    }
    return {
      ...(await this.#sendActionOnSocket(socket, action, data)),
      helperBundleIdentifier: this.#socketPeers.get(socket)?.bundleIdentifier ?? "unknown",
      helperPeer: this.#socketPeers.get(socket),
    };
  }

  async #sendActionToAll(
    action: string,
    data: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<HelperActionResult> {
    const sockets = [...this.#sockets].filter(
      (candidate) =>
        !candidate.destroyed &&
        FACETIME_HELPER_BUNDLES.has(this.#socketPeers.get(candidate)?.bundleIdentifier ?? ""),
    );
    if (sockets.length === 0) {
      throw new FaceTimeHelperUnavailableError(
        "FaceTime helper is not connected to the facetime event socket",
      );
    }
    const results = await Promise.allSettled(
      sockets.map((socket) => this.#sendActionOnSocket(socket, action, data, timeoutMs)),
    );
    const fulfilled = results.flatMap((result, index) =>
      result.status === "fulfilled" && sockets[index]
        ? [
            {
              ...result.value,
              helperBundleIdentifier:
                this.#socketPeers.get(sockets[index])?.bundleIdentifier ?? "unknown",
              helperPeer: this.#socketPeers.get(sockets[index]),
            },
          ]
        : [],
    );
    if (fulfilled.length > 0) {
      return {
        helpersContacted: sockets.length,
        topologyGeneration: this.#connectionGeneration,
        topologyComplete: fulfilled.length === sockets.length,
        helperResults: fulfilled,
        ...fulfilled[fulfilled.length - 1],
      };
    }
    const firstRejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw firstRejected?.reason instanceof Error
      ? firstRejected.reason
      : new Error(`FaceTime helper action failed: ${action}`);
  }

  async #sendActionOnSocket(
    socket: net.Socket,
    action: string,
    data: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<HelperActionResult> {
    if (this.#pending.size >= MAX_PENDING_ACTIONS) {
      throw new FaceTimeHelperUnavailableError("FaceTime helper action queue is full");
    }
    const transactionId = randomUUID();
    if (!this.#socketAuthSessions.has(socket)) {
      throw new FaceTimeHelperUnavailableError("FaceTime helper socket is not authenticated");
    }
    return await new Promise<HelperActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(transactionId);
        reject(new Error(`FaceTime helper action timed out: ${action}`));
      }, timeoutMs);
      this.#pending.set(transactionId, { resolve, reject, timeout });
      try {
        this.#writeServerPayload(socket, { action, transactionId, data });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(transactionId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export function readHelperResults(result: HelperActionResult): HelperActionResult[] {
  return Array.isArray(result.helperResults)
    ? result.helperResults.filter((entry): entry is HelperActionResult =>
        Boolean(entry && typeof entry === "object"),
      )
    : [result];
}

function requireCompleteTopology(result: HelperActionResult): HelperActionResult[] {
  const results = readHelperResults(result);
  if (
    result.topologyComplete !== true ||
    typeof result.helpersContacted !== "number" ||
    results.length !== result.helpersContacted
  ) {
    throw new FaceTimeHelperAmbiguousError("FaceTime helper topology was incomplete", result);
  }
  return results;
}

export function projectFaceTimeNativeAction(
  action: "answer" | "safe-mute" | "unmute" | "activate" | "terminate",
  result: HelperActionResult,
): FaceTimeNativeActionOutcome {
  const results = requireCompleteTopology(result);
  const present = results.filter((entry) => entry.outcome !== "absent");
  if (present.length !== 1) {
    throw new FaceTimeHelperAmbiguousError(
      `FaceTime ${action} matched ${present.length} carrier owners`,
      result,
    );
  }
  const observed = present[0];
  if (!observed) {
    throw new FaceTimeHelperAmbiguousError(`FaceTime ${action} carrier owner is missing`, result);
  }
  if (
    action === "unmute" &&
    observed.muted === false &&
    observed.is_uplink_muted === false &&
    typeof observed.conversation_audio_error !== "string"
  ) {
    return { status: "media-active" };
  }
  if (
    action === "answer" &&
    observed.outcome === "answered-muted" &&
    observed.muted === true &&
    observed.is_uplink_muted === true
  ) {
    return { status: "answered-muted" };
  }
  if (
    action === "safe-mute" &&
    observed.downlink_muted === true &&
    observed.muted === true &&
    observed.is_uplink_muted === true
  ) {
    return { status: "safe-muted" };
  }
  if (
    action === "activate" &&
    observed.muted === false &&
    observed.is_uplink_muted === false &&
    observed.is_sending_audio === true &&
    observed.is_sending_transmission === true &&
    typeof observed.conversation_audio_error !== "string"
  ) {
    return { status: "media-active" };
  }
  if (action === "terminate" && observed.outcome === "termination-requested") {
    return { status: "termination-requested" };
  }
  throw new FaceTimeHelperActionError(`FaceTime ${action} postcondition was not observed`);
}

export function projectCompleteFaceTimeAbsence(result: HelperActionResult): {
  status: "absent";
  topologyGeneration: number;
} {
  const results = requireCompleteTopology(result);
  if (!results.every((entry) => entry.outcome === "absent" && entry.found === false)) {
    throw new FaceTimeHelperAmbiguousError("FaceTime carrier is still present", result);
  }
  if (typeof result.topologyGeneration !== "number") {
    throw new FaceTimeHelperAmbiguousError("FaceTime topology generation is missing", result);
  }
  return { status: "absent", topologyGeneration: result.topologyGeneration };
}
