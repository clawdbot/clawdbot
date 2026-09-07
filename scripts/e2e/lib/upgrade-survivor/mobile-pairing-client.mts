#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type JsonRecord = Record<string, unknown>;
type MobileClientMetadata = {
  id: string;
  displayName: string;
  version: string;
  platform: string;
  deviceFamily: string;
  instanceId: string;
};
type MobilePairingIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};
type ConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  password?: string;
};
type ConnectRole = "node" | "operator";
type ConnectMode = "node" | "ui" | "cli" | "backend";
type StoredRoleCredential = {
  token: string;
  scopes: string[];
};
export type MobilePairingCredentials = {
  version: 1;
  url: string;
  client: MobileClientMetadata;
  identity: MobilePairingIdentity;
  node: StoredRoleCredential;
  operator: StoredRoleCredential;
};
export type StoredCredentialTransition = {
  role: ConnectRole;
  scopes: string[];
  usedTokenHash: string;
  storedTokenHash: string;
  deviceTokenReturned: boolean;
  tokenRotated: boolean;
};
export type MobilePairingAudit = {
  pendingDevicePairingCount: 0;
  pendingNodePairingCount: 0 | 1;
  pairedDevicePresent: true;
  pairedNodePresent: true;
  nodeSurfaceReapprovalRequired: boolean;
  nodeSurfaceCommandAdditions: string[];
};
type WebSocketLike = {
  readyState: number;
  close: () => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  send: (value: string) => void;
};
type WebSocketConstructor = {
  new (url: string): WebSocketLike;
  CLOSED: number;
};
type ConnectResult = {
  socket: WebSocketLike;
  hello: JsonRecord;
};

export const MOBILE_PAIRING_CLIENT: MobileClientMetadata = Object.freeze({
  id: "openclaw-ios",
  displayName: "Upgrade Survivor iPhone",
  version: "2026.8.10",
  platform: "iOS 26.6.1",
  deviceFamily: "iPhone",
  instanceId: "21f53145-05d4-4af0-91df-391f4f11601f",
});

export const MOBILE_PAIRING_AUDIT_CLIENT: MobileClientMetadata = Object.freeze({
  id: "gateway-client",
  displayName: "Upgrade Survivor Pairing Audit",
  version: MOBILE_PAIRING_CLIENT.version,
  platform: "linux",
  deviceFamily: "CLI",
  instanceId: "c0202128-dbd7-42a5-a8ac-aaf20dc14c9c",
});

// Shipped iOS 2026.8.10 builds derive this default-on iPhone surface before
// every node connect. Keep it fixed so historical reconnects cannot drift.
export const MOBILE_PAIRING_NODE_CAPS = Object.freeze([
  "canvas",
  "screen",
  "camera",
  "device",
  "talk",
  "watch",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "motion",
]);

export const MOBILE_PAIRING_NODE_COMMANDS = Object.freeze([
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
  "screen.record",
  "system.notify",
  "chat.push",
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
  "camera.list",
  "camera.snap",
  "camera.clip",
  "device.status",
  "device.info",
  "watch.status",
  "watch.notify",
  "photos.latest",
  "contacts.search",
  "contacts.add",
  "calendar.events",
  "calendar.add",
  "reminders.list",
  "reminders.add",
  "motion.activity",
  "motion.pedometer",
]);

export const MOBILE_PAIRING_NODE_PERMISSIONS = Object.freeze({
  camera: false,
  microphone: false,
  speechRecognition: false,
  location: false,
  screenRecording: true,
  photos: false,
  contacts: false,
  calendar: false,
  reminders: false,
  motion: false,
});

export const MOBILE_PAIRING_OPERATOR_CAPS = Object.freeze(["inline-widgets"]);
export const MOBILE_PAIRING_APPROVAL_SCOPES = Object.freeze(["operator.pairing", "operator.admin"]);

const GATEWAY_PROTOCOL_VERSION = 4;
const GATEWAY_MIN_NODE_PROTOCOL_VERSION = 3;
const PAIRING_AUDIT_SCOPES = ["operator.pairing"];
const EXPECTED_UPGRADE_COMMAND_ADDITIONS = ["watch.notify", "watch.status"];
const BASELINE_PAIRING_POLL_ATTEMPTS = 50;
const BASELINE_PAIRING_POLL_INTERVAL_MS = 100;
const RESPONSE_TIMEOUT_MS = 15_000;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} missing`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} invalid`);
  }
  return [...value];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildDeviceAuthCompatibilityPayloadV2(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

export function parseConnectChallengePayload(value: unknown): {
  nonce: string;
  issuedAtMs: number;
} {
  if (!isRecord(value)) {
    throw new Error("Gateway challenge payload invalid");
  }
  const nonce = requireString(value.nonce, "Gateway challenge nonce").trim();
  if (!nonce) {
    throw new Error("Gateway challenge nonce missing");
  }
  const issuedAtMs = value.ts;
  if (typeof issuedAtMs !== "number" || !Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
    throw new Error("Gateway challenge timestamp invalid");
  }
  return { nonce, issuedAtMs };
}

function protocolRangeForClient(
  role: ConnectRole,
  mode: ConnectMode,
): { minProtocol: number; maxProtocol: number } {
  return {
    minProtocol:
      role === "node" && mode === "node"
        ? GATEWAY_MIN_NODE_PROTOCOL_VERSION
        : GATEWAY_PROTOCOL_VERSION,
    maxProtocol: GATEWAY_PROTOCOL_VERSION,
  };
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(-32)).toString("base64url");
}

export function createMobilePairingIdentity(): MobilePairingIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const rawPublicKey = publicKeyRawBase64Url(publicKeyPem);
  return {
    deviceId: sha256(Buffer.from(rawPublicKey, "base64url")),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function signDeviceAuthPayload(privateKeyPem: string, payload: string): string {
  return sign(null, Buffer.from(payload), createPrivateKey(privateKeyPem)).toString("base64url");
}

export function verifyDeviceAuthPayloadSignature(params: {
  publicKeyPem: string;
  payload: string;
  signature: string;
}): boolean {
  return verify(
    null,
    Buffer.from(params.payload),
    createPublicKey(params.publicKeyPem),
    Buffer.from(params.signature, "base64url"),
  );
}

export function parseQrBootstrapJson(value: unknown): { url: string; bootstrapToken: string } {
  if (!isRecord(value)) {
    throw new Error("QR JSON invalid");
  }
  const setupCode = requireString(value.setupCode, "QR setup code");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8"));
  } catch {
    throw new Error("QR setup payload invalid");
  }
  if (!isRecord(payload)) {
    throw new Error("QR setup payload invalid");
  }
  const url = requireString(payload.url, "QR setup URL");
  const bootstrapToken = requireString(payload.bootstrapToken, "QR bootstrap token");
  if (!/^wss?:\/\//u.test(url)) {
    throw new Error("QR setup URL invalid");
  }
  return { url, bootstrapToken };
}

export function extractBootstrapCredentials(params: {
  url: string;
  client: MobileClientMetadata;
  identity: MobilePairingIdentity;
  hello: unknown;
}): MobilePairingCredentials {
  if (!isRecord(params.hello) || !isRecord(params.hello.auth)) {
    throw new Error("baseline hello auth missing");
  }
  const auth = params.hello.auth;
  const role = requireString(auth.role, "baseline hello role");
  const scopes = requireStringArray(auth.scopes, "baseline node scopes");
  if (role !== "node" || scopes.length !== 0) {
    throw new Error("baseline node auth metadata changed");
  }
  const nodeToken = requireString(auth.deviceToken, "baseline node token");
  if (!Array.isArray(auth.deviceTokens)) {
    throw new Error("baseline operator handoff missing");
  }
  const operator = auth.deviceTokens.find(
    (entry) => isRecord(entry) && entry.role === "operator",
  ) as JsonRecord | undefined;
  if (!operator) {
    throw new Error("baseline operator handoff missing");
  }
  const operatorToken = requireString(operator.deviceToken, "baseline operator token");
  const operatorScopes = requireStringArray(operator.scopes, "baseline operator scopes");
  if (operatorScopes.length === 0) {
    throw new Error("baseline operator scopes missing");
  }
  return {
    version: 1,
    url: params.url,
    client: params.client,
    identity: params.identity,
    node: { token: nodeToken, scopes },
    operator: { token: operatorToken, scopes: operatorScopes },
  };
}

export function buildConnectRequest(params: {
  id?: string;
  challengePayload: unknown;
  client: MobileClientMetadata;
  mode: ConnectMode;
  role: ConnectRole;
  scopes: string[];
  auth?: ConnectAuth;
  identity?: MobilePairingIdentity;
}): JsonRecord {
  const challenge = parseConnectChallengePayload(params.challengePayload);
  const protocolRange = protocolRangeForClient(params.role, params.mode);
  const signatureToken = params.auth?.token ?? params.auth?.bootstrapToken ?? null;
  const isNode = params.role === "node" && params.mode === "node";
  const device = params.identity
    ? {
        id: params.identity.deviceId,
        publicKey: publicKeyRawBase64Url(params.identity.publicKeyPem),
        signature: signDeviceAuthPayload(
          params.identity.privateKeyPem,
          buildDeviceAuthCompatibilityPayloadV2({
            deviceId: params.identity.deviceId,
            clientId: params.client.id,
            clientMode: params.mode,
            role: params.role,
            scopes: params.scopes,
            signedAtMs: challenge.issuedAtMs,
            token: signatureToken,
            nonce: challenge.nonce,
          }),
        ),
        signedAt: challenge.issuedAtMs,
        nonce: challenge.nonce,
      }
    : undefined;
  return {
    type: "req",
    id: params.id ?? `connect-${randomUUID()}`,
    method: "connect",
    params: {
      ...protocolRange,
      client: { ...params.client, mode: params.mode },
      caps: isNode ? [...MOBILE_PAIRING_NODE_CAPS] : [...MOBILE_PAIRING_OPERATOR_CAPS],
      locale: "en-US",
      userAgent: "Version 26.6.1",
      ...(isNode
        ? {
            commands: [...MOBILE_PAIRING_NODE_COMMANDS],
            permissions: { ...MOBILE_PAIRING_NODE_PERMISSIONS },
          }
        : {}),
      role: params.role,
      scopes: params.scopes,
      ...(params.auth ? { auth: params.auth } : {}),
      ...(device ? { device } : {}),
    },
  };
}

function parseFrame(value: unknown): JsonRecord | null {
  try {
    const parsed = JSON.parse(String(value));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function receiveFrame(
  socket: WebSocketLike,
  predicate: (frame: JsonRecord) => boolean,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Gateway response timed out"));
    }, timeoutMs);
    const onMessage = (value: unknown) => {
      const frame = parseFrame(value);
      if (!frame || !predicate(frame)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    };
    socket.on("message", onMessage);
  });
}

function waitForOpen(socket: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", () => reject(new Error("Gateway WebSocket open failed")));
  });
}

function waitForClose(socket: WebSocketLike): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code: unknown) =>
      resolve(typeof code === "number" ? code : Number(code)),
    );
  });
}

async function closeSocket(socket: WebSocketLike, WebSocket: WebSocketConstructor): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = waitForClose(socket).then(() => undefined);
  socket.close();
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    }),
  ]);
}

function loadWebSocket(packageRoot: string): WebSocketConstructor {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const loaded = require("ws") as { WebSocket?: WebSocketConstructor } | WebSocketConstructor;
  const WebSocket =
    typeof loaded === "function"
      ? loaded
      : (loaded as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!WebSocket) {
    throw new Error("installed OpenClaw WebSocket runtime missing");
  }
  return WebSocket;
}

export async function attemptConnect(params: {
  WebSocket: WebSocketConstructor;
  url: string;
  client: MobileClientMetadata;
  mode: ConnectMode;
  role: ConnectRole;
  scopes: string[];
  auth?: ConnectAuth;
  identity?: MobilePairingIdentity;
}): Promise<{
  socket: WebSocketLike;
  response: JsonRecord;
  closeCode: Promise<number>;
}> {
  const socket = new params.WebSocket(params.url);
  const closeCode = waitForClose(socket);
  try {
    const challenge = receiveFrame(
      socket,
      (frame) => frame.type === "event" && frame.event === "connect.challenge",
    );
    await waitForOpen(socket);
    const challengeFrame = await challenge;
    const payload = isRecord(challengeFrame.payload) ? challengeFrame.payload : null;
    const connectRequest = buildConnectRequest({
      challengePayload: payload,
      client: params.client,
      mode: params.mode,
      role: params.role,
      scopes: params.scopes,
      auth: params.auth,
      identity: params.identity,
    });
    const requestId = requireString(connectRequest.id, "connect request id");
    const response = receiveFrame(
      socket,
      (frame) => frame.type === "res" && frame.id === requestId,
    );
    socket.send(JSON.stringify(connectRequest));
    return { socket, response: await response, closeCode };
  } catch (error) {
    await closeSocket(socket, params.WebSocket);
    throw error;
  }
}

async function connect(params: Parameters<typeof attemptConnect>[0]): Promise<ConnectResult> {
  const result = await attemptConnect(params);
  if (result.response.ok !== true || !isRecord(result.response.payload)) {
    result.socket.close();
    throw new Error("Gateway connect failed");
  }
  if (result.response.payload.type !== "hello-ok") {
    result.socket.close();
    throw new Error("Gateway connect did not return hello-ok");
  }
  return { socket: result.socket, hello: result.response.payload };
}

async function request(socket: WebSocketLike, method: string, params: JsonRecord = {}) {
  const id = `rpc-${randomUUID()}`;
  const response = receiveFrame(socket, (frame) => frame.type === "res" && frame.id === id);
  socket.send(JSON.stringify({ type: "req", id, method, params }));
  const frame = await response;
  if (frame.ok !== true) {
    throw new Error(`${method} failed`);
  }
  return frame.payload;
}

function readHelloAuth(
  hello: JsonRecord,
  role: ConnectRole,
  expectedScopes: string[],
): { scopes: string[]; deviceToken?: string } {
  if (!isRecord(hello.auth)) {
    throw new Error(`${role} hello auth missing`);
  }
  if (hello.auth.role !== role) {
    throw new Error(`${role} hello role changed`);
  }
  const actualScopes = requireStringArray(hello.auth.scopes, `${role} hello scopes`);
  if (JSON.stringify(actualScopes) !== JSON.stringify(expectedScopes)) {
    throw new Error(`${role} hello scopes changed`);
  }
  if (hello.auth.deviceToken !== undefined && typeof hello.auth.deviceToken !== "string") {
    throw new Error(`${role} hello device token invalid`);
  }
  return {
    scopes: actualScopes,
    ...(typeof hello.auth.deviceToken === "string" ? { deviceToken: hello.auth.deviceToken } : {}),
  };
}

export function persistHelloCredential(params: {
  credentials: MobilePairingCredentials;
  role: ConnectRole;
  hello: JsonRecord;
}): StoredCredentialTransition {
  const previous = params.credentials[params.role];
  const auth = readHelloAuth(params.hello, params.role, previous.scopes);
  if (auth.deviceToken !== undefined) {
    params.credentials[params.role] = {
      token: auth.deviceToken,
      scopes: auth.scopes,
    };
  }
  const stored = params.credentials[params.role];
  return {
    role: params.role,
    scopes: auth.scopes,
    usedTokenHash: sha256(previous.token),
    storedTokenHash: sha256(stored.token),
    deviceTokenReturned: auth.deviceToken !== undefined,
    tokenRotated: previous.token !== stored.token,
  };
}

async function assertMissingPassword(params: {
  WebSocket: WebSocketConstructor;
  credentials: MobilePairingCredentials;
}): Promise<void> {
  const result = await attemptConnect({
    WebSocket: params.WebSocket,
    url: params.credentials.url,
    client: params.credentials.client,
    mode: "node",
    role: "node",
    scopes: [],
    identity: params.credentials.identity,
  });
  const details =
    isRecord(result.response.error) && isRecord(result.response.error.details)
      ? result.response.error.details
      : {};
  const authReason = details.authReason ?? details.reason;
  if (result.response.ok !== false || authReason !== "password_missing") {
    result.socket.close();
    throw new Error("unauthenticated password-mode connect did not report password_missing");
  }
  const closeCode = await Promise.race([
    result.closeCode,
    new Promise<number>((_, reject) => {
      setTimeout(() => reject(new Error("unauthenticated connect did not close")), 2_000);
    }),
  ]);
  if (closeCode !== 1008) {
    throw new Error("unauthenticated password-mode connect did not close with 1008");
  }
}

async function auditPairingState(params: {
  WebSocket: WebSocketConstructor;
  credentials: MobilePairingCredentials;
  password: string;
  expectKnownNodeSurfaceUpgrade: boolean;
}): Promise<MobilePairingAudit> {
  // Match the node approval CLI's local backend shared-auth path. Keep this
  // audit device-less so it cannot rotate mobile tokens.
  const audit = await connect({
    WebSocket: params.WebSocket,
    url: params.credentials.url,
    client: MOBILE_PAIRING_AUDIT_CLIENT,
    mode: "backend",
    role: "operator",
    scopes: PAIRING_AUDIT_SCOPES,
    auth: { password: params.password },
  });
  try {
    readHelloAuth(audit.hello, "operator", PAIRING_AUDIT_SCOPES);
    return validatePairingAudit({
      devicePairing: await request(audit.socket, "device.pair.list"),
      nodePairing: await request(audit.socket, "node.pair.list"),
      deviceId: params.credentials.identity.deviceId,
      expectKnownNodeSurfaceUpgrade: params.expectKnownNodeSurfaceUpgrade,
    });
  } finally {
    await closeSocket(audit.socket, params.WebSocket);
  }
}

export function validatePairingAudit(params: {
  devicePairing: unknown;
  nodePairing: unknown;
  deviceId: string;
  expectKnownNodeSurfaceUpgrade?: boolean;
}): MobilePairingAudit {
  if (!isRecord(params.devicePairing) || !Array.isArray(params.devicePairing.pending)) {
    throw new Error("mobile device pairing audit invalid");
  }
  if (params.devicePairing.pending.length !== 0) {
    throw new Error("mobile device pairing left a pending request");
  }
  const pairedDevices = Array.isArray(params.devicePairing.paired)
    ? params.devicePairing.paired
    : [];
  if (!pairedDevices.some((entry) => isRecord(entry) && entry.deviceId === params.deviceId)) {
    throw new Error("paired mobile device missing");
  }

  if (
    !isRecord(params.nodePairing) ||
    !Array.isArray(params.nodePairing.pending) ||
    !Array.isArray(params.nodePairing.paired)
  ) {
    throw new Error("mobile node pairing audit invalid");
  }
  const pairedNode = params.nodePairing.paired.find(
    (entry) => isRecord(entry) && entry.nodeId === params.deviceId,
  );
  if (!isRecord(pairedNode)) {
    throw new Error("paired mobile node missing");
  }
  if (params.nodePairing.pending.length === 0) {
    if (params.expectKnownNodeSurfaceUpgrade) {
      throw new Error("mobile node pairing omitted the expected command-surface reapproval");
    }
    return {
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      nodeSurfaceReapprovalRequired: false,
      nodeSurfaceCommandAdditions: [],
    };
  }
  if (!params.expectKnownNodeSurfaceUpgrade || params.nodePairing.pending.length !== 1) {
    throw new Error("mobile node pairing left an unexpected pending request");
  }
  const pendingNode = params.nodePairing.pending[0];
  if (!isRecord(pendingNode) || pendingNode.nodeId !== params.deviceId) {
    throw new Error("mobile node pairing pending identity changed");
  }
  const pairedCommands = new Set(
    requireStringArray(pairedNode.commands ?? [], "paired node commands"),
  );
  const pendingCommands = requireStringArray(pendingNode.commands ?? [], "pending node commands");
  const commandAdditions = pendingCommands
    .filter((command) => !pairedCommands.has(command))
    .toSorted();
  if (JSON.stringify(commandAdditions) !== JSON.stringify(EXPECTED_UPGRADE_COMMAND_ADDITIONS)) {
    throw new Error("mobile node pairing pending command expansion changed");
  }
  const pairedCaps = new Set(requireStringArray(pairedNode.caps ?? [], "paired node caps"));
  const capabilityAdditions = requireStringArray(
    pendingNode.caps ?? [],
    "pending node caps",
  ).filter((capability) => !pairedCaps.has(capability));
  if (capabilityAdditions.length !== 0) {
    throw new Error("mobile node pairing pending capability expansion changed");
  }
  const pairedPermissions = isRecord(pairedNode.permissions) ? pairedNode.permissions : {};
  const pendingPermissions = isRecord(pendingNode.permissions) ? pendingNode.permissions : {};
  if (
    Object.entries(pendingPermissions).some(
      ([permission, enabled]) => enabled === true && pairedPermissions[permission] !== true,
    )
  ) {
    throw new Error("mobile node pairing pending permission expansion changed");
  }
  return {
    pendingDevicePairingCount: 0,
    pendingNodePairingCount: 1,
    pairedDevicePresent: true,
    pairedNodePresent: true,
    nodeSurfaceReapprovalRequired: true,
    nodeSurfaceCommandAdditions: commandAdditions,
  };
}

export function assertGatewayHealth(value: unknown): void {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error("Gateway health response invalid");
  }
}

export function inspectBaselineNodePairing(
  value: unknown,
  deviceId: string,
): { pendingRequestId: string | null; paired: boolean } {
  if (!isRecord(value) || !Array.isArray(value.pending) || !Array.isArray(value.paired)) {
    throw new Error("baseline node pairing audit invalid");
  }
  if (value.pending.some((entry) => !isRecord(entry) || entry.nodeId !== deviceId)) {
    throw new Error("baseline node pairing has an unexpected pending request");
  }
  const pending = value.pending.filter((entry) => isRecord(entry) && entry.nodeId === deviceId);
  if (pending.length > 1) {
    throw new Error("baseline node pairing has duplicate pending requests");
  }
  const pendingRequestId =
    pending.length === 1
      ? requireString((pending[0] as JsonRecord).requestId, "baseline node pairing request id")
      : null;
  const paired = value.paired.some((entry) => isRecord(entry) && entry.nodeId === deviceId);
  return { pendingRequestId, paired };
}

export async function approveBaselineNodePairing(params: {
  deviceId: string;
  listPairings: () => Promise<unknown>;
  approvePairing: (requestId: string) => Promise<unknown>;
  wait?: () => Promise<void>;
}): Promise<void> {
  let approvedRequestId: string | null = null;
  const wait =
    params.wait ??
    (() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, BASELINE_PAIRING_POLL_INTERVAL_MS);
      }));
  for (let attempt = 0; attempt < BASELINE_PAIRING_POLL_ATTEMPTS; attempt += 1) {
    const state = inspectBaselineNodePairing(await params.listPairings(), params.deviceId);
    if (state.pendingRequestId && state.pendingRequestId !== approvedRequestId) {
      await params.approvePairing(state.pendingRequestId);
      approvedRequestId = state.pendingRequestId;
    }
    if (!state.pendingRequestId && state.paired) {
      return;
    }
    await wait();
  }
  throw new Error("baseline node pairing did not complete");
}

async function completeBaselineNodePairing(params: {
  WebSocket: WebSocketConstructor;
  credentials: MobilePairingCredentials;
  password: string;
}): Promise<void> {
  const operator = await connect({
    WebSocket: params.WebSocket,
    url: params.credentials.url,
    client: MOBILE_PAIRING_AUDIT_CLIENT,
    mode: "backend",
    role: "operator",
    scopes: [...MOBILE_PAIRING_APPROVAL_SCOPES],
    auth: { password: params.password },
  });
  try {
    readHelloAuth(operator.hello, "operator", [...MOBILE_PAIRING_APPROVAL_SCOPES]);
    await approveBaselineNodePairing({
      deviceId: params.credentials.identity.deviceId,
      listPairings: () => request(operator.socket, "node.pair.list"),
      approvePairing: (requestId) =>
        request(operator.socket, "node.pair.approve", {
          requestId,
        }),
    });
  } finally {
    await closeSocket(operator.socket, params.WebSocket);
  }
}

export function buildRedactedEvidence(params: {
  phase: string;
  credentials: MobilePairingCredentials;
  node: StoredCredentialTransition;
  operator: StoredCredentialTransition;
  pairing: MobilePairingAudit;
  expectKnownNodeSurfaceUpgrade: boolean;
}): JsonRecord {
  return {
    phase: params.phase,
    ok: true,
    client: {
      id: params.credentials.client.id,
      version: params.credentials.client.version,
      platform: params.credentials.client.platform,
      deviceFamily: params.credentials.client.deviceFamily,
      instanceIdHash: sha256(params.credentials.client.instanceId),
    },
    hello: {
      nodeRole: "node",
      nodeScopes: params.credentials.node.scopes,
      operatorRole: "operator",
      operatorScopes: params.credentials.operator.scopes,
    },
    health: true,
    connectedDevicePresent: true,
    pendingPairingCount:
      params.pairing.pendingDevicePairingCount + params.pairing.pendingNodePairingCount,
    ...params.pairing,
    nodeSurfaceReapprovalExpected: params.expectKnownNodeSurfaceUpgrade,
    missingPasswordReason: true,
    missingPasswordClose1008: true,
    credentials: {
      node: {
        usedTokenHash: params.node.usedTokenHash,
        storedTokenHash: params.node.storedTokenHash,
        deviceTokenReturned: params.node.deviceTokenReturned,
        tokenRotated: params.node.tokenRotated,
      },
      operator: {
        usedTokenHash: params.operator.usedTokenHash,
        storedTokenHash: params.operator.storedTokenHash,
        deviceTokenReturned: params.operator.deviceTokenReturned,
        tokenRotated: params.operator.tokenRotated,
      },
    },
  };
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateJson(file: string, value: unknown): void {
  ensurePrivateDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writeRedactedEvidence(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateCredentials(value: unknown): MobilePairingCredentials {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.client) ||
    !isRecord(value.identity)
  ) {
    throw new Error("mobile pairing credentials invalid");
  }
  const credentials = value as unknown as MobilePairingCredentials;
  requireString(credentials.url, "stored Gateway URL");
  requireString(credentials.client.instanceId, "stored client instance id");
  requireString(credentials.identity.deviceId, "stored device id");
  requireString(credentials.identity.privateKeyPem, "stored private key");
  requireString(credentials.node?.token, "stored node token");
  requireString(credentials.operator?.token, "stored operator token");
  requireStringArray(credentials.node?.scopes, "stored node scopes");
  requireStringArray(credentials.operator?.scopes, "stored operator scopes");
  return credentials;
}

async function verifyReconnect(params: {
  packageRoot: string;
  credentials: MobilePairingCredentials;
  credentialsFile: string;
  password: string;
  phase: string;
  evidenceFile: string;
  expectKnownNodeSurfaceUpgrade: boolean;
}): Promise<void> {
  const WebSocket = loadWebSocket(params.packageRoot);
  await assertMissingPassword({ WebSocket, credentials: params.credentials });
  const node = await connect({
    WebSocket,
    url: params.credentials.url,
    client: params.credentials.client,
    mode: "node",
    role: "node",
    scopes: params.credentials.node.scopes,
    auth: { token: params.credentials.node.token },
    identity: params.credentials.identity,
  });
  let operator: ConnectResult | undefined;
  try {
    const nodeTransition = persistHelloCredential({
      credentials: params.credentials,
      role: "node",
      hello: node.hello,
    });
    writePrivateJson(params.credentialsFile, params.credentials);
    operator = await connect({
      WebSocket,
      url: params.credentials.url,
      client: params.credentials.client,
      mode: "ui",
      role: "operator",
      scopes: params.credentials.operator.scopes,
      auth: { token: params.credentials.operator.token },
      identity: params.credentials.identity,
    });
    const operatorTransition = persistHelloCredential({
      credentials: params.credentials,
      role: "operator",
      hello: operator.hello,
    });
    writePrivateJson(params.credentialsFile, params.credentials);
    assertGatewayHealth(await request(operator.socket, "health"));
    const nodeList = await request(operator.socket, "node.list");
    const nodes = Array.isArray(nodeList)
      ? nodeList
      : isRecord(nodeList) && Array.isArray(nodeList.nodes)
        ? nodeList.nodes
        : [];
    const connectedNode = nodes.find(
      (entry) =>
        isRecord(entry) &&
        (entry.nodeId === params.credentials.identity.deviceId ||
          entry.id === params.credentials.identity.deviceId),
    );
    if (!isRecord(connectedNode) || connectedNode.connected !== true) {
      throw new Error("node.list omitted the connected mobile device");
    }
    const pairing = await auditPairingState({
      WebSocket,
      credentials: params.credentials,
      password: params.password,
      expectKnownNodeSurfaceUpgrade: params.expectKnownNodeSurfaceUpgrade,
    });
    writeRedactedEvidence(
      params.evidenceFile,
      buildRedactedEvidence({
        phase: params.phase,
        credentials: params.credentials,
        node: nodeTransition,
        operator: operatorTransition,
        pairing,
        expectKnownNodeSurfaceUpgrade: params.expectKnownNodeSurfaceUpgrade,
      }),
    );
  } finally {
    if (operator) {
      await closeSocket(operator.socket, WebSocket);
    }
    await closeSocket(node.socket, WebSocket);
  }
}

function parseArgs(argv: string[]): { command: string; options: Map<string, string> } {
  const [command = "", ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("mobile pairing client arguments invalid");
    }
    options.set(key, value);
  }
  return { command, options };
}

function option(options: Map<string, string>, name: string): string {
  return requireString(options.get(name), name);
}

function booleanOption(options: Map<string, string>, name: string): boolean {
  const value = option(options, name);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} invalid`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const packageRoot = option(options, "--package-root");
  const credentialsFile = option(options, "--credentials");
  const evidenceFile = option(options, "--evidence");
  const password = requireString(process.env.GATEWAY_AUTH_PASSWORD_REF, "Gateway password env");
  if (command === "bootstrap") {
    const qr = parseQrBootstrapJson(readJson(option(options, "--qr-json")));
    const identity = createMobilePairingIdentity();
    const WebSocket = loadWebSocket(packageRoot);
    const initial = await connect({
      WebSocket,
      url: qr.url,
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: [],
      auth: { bootstrapToken: qr.bootstrapToken },
      identity,
    });
    const credentials = extractBootstrapCredentials({
      url: qr.url,
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: initial.hello,
    });
    await closeSocket(initial.socket, WebSocket);
    writePrivateJson(credentialsFile, credentials);
    await completeBaselineNodePairing({
      WebSocket,
      credentials,
      password,
    });
    await verifyReconnect({
      packageRoot,
      credentials,
      credentialsFile,
      password,
      phase: "baseline",
      evidenceFile,
      expectKnownNodeSurfaceUpgrade: false,
    });
  } else if (command === "verify") {
    const credentials = validateCredentials(readJson(credentialsFile));
    await verifyReconnect({
      packageRoot,
      credentials,
      credentialsFile,
      password,
      phase: option(options, "--phase"),
      evidenceFile,
      expectKnownNodeSurfaceUpgrade: booleanOption(
        options,
        "--expect-known-node-surface-reapproval",
      ),
    });
  } else {
    throw new Error("unknown mobile pairing client command");
  }
  process.stdout.write(`${JSON.stringify({ phase: command, ok: true })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`mobile pairing client failed: ${message}\n`);
    process.exitCode = 1;
  });
}
