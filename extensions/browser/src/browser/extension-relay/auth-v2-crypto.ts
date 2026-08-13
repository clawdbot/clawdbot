import crypto from "node:crypto";

export const BROWSER_RELAY_AUTH_LABEL = "openclaw.browser-relay.auth" as const;
export const BROWSER_RELAY_AUTH_VERSION = 2 as const;

const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

type BrowserRelayProofKind = "server" | "client" | "accept";
type BrowserRelayRole = "extension" | "cdp";
type BrowserRelayTransport = "websocket" | "connection";
type BrowserRelayMethod = "GET" | "SEQUENCE";
type BrowserRelayFlow = "extension" | "cdp" | "json-list";

export type BrowserRelayProofFields = {
  keyId: string;
  instanceId: string;
  sessionId: string;
  clientNonce: string;
  serverNonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  role: BrowserRelayRole;
  transport: BrowserRelayTransport;
  method: BrowserRelayMethod;
  resource: string;
  flow: BrowserRelayFlow;
};

export type BrowserRelayAuthChallenge = BrowserRelayProofFields & {
  type: "auth.challenge";
  v: 2;
  serverProof: string;
};

export type BrowserRelayAuthOk = {
  type: "auth.ok";
  v: 2;
  sessionId: string;
  acceptProof: string;
};

function decodeRelayKey(keyHex: string): Buffer {
  if (!KEY_HEX_PATTERN.test(keyHex)) {
    throw new Error("browser relay key must be 32 lowercase-hex bytes");
  }
  return Buffer.from(keyHex, "hex");
}

export function isCanonicalBase64UrlBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function isBase64UrlText(value: string): boolean {
  return BASE64URL_PATTERN.test(value);
}

export function relayKeyIdFromHex(keyHex: string): string {
  return crypto
    .createHash("sha256")
    .update(decodeRelayKey(keyHex))
    .digest("base64url")
    .slice(0, 22);
}

export function randomRelayNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function randomRelayId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function canonicalRelayProofBytes(
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  clientProof?: string,
): Buffer {
  const values: unknown[] = [
    BROWSER_RELAY_AUTH_LABEL,
    BROWSER_RELAY_AUTH_VERSION,
    proofKind,
    fields.keyId,
    fields.instanceId,
    fields.sessionId,
    fields.clientNonce,
    fields.serverNonce,
    fields.issuedAtMs,
    fields.expiresAtMs,
    fields.role,
    fields.transport,
    fields.method,
    fields.resource,
    fields.flow,
  ];
  if (proofKind === "accept") {
    if (!isCanonicalBase64UrlBytes(clientProof, 32)) {
      throw new Error("accept proof requires a 32-byte client proof");
    }
    values.push(clientProof);
  }
  return Buffer.from(JSON.stringify(values), "utf8");
}

export function createRelayProof(
  keyHex: string,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  clientProof?: string,
): string {
  return crypto
    .createHmac("sha256", decodeRelayKey(keyHex))
    .update(canonicalRelayProofBytes(proofKind, fields, clientProof))
    .digest("base64url");
}

export function verifyRelayProof(
  keyHex: string,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  candidate: unknown,
  clientProof?: string,
): boolean {
  if (!isCanonicalBase64UrlBytes(candidate, 32)) {
    return false;
  }
  const expected = Buffer.from(
    createRelayProof(keyHex, proofKind, fields, clientProof),
    "base64url",
  );
  const actual = Buffer.from(candidate, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
