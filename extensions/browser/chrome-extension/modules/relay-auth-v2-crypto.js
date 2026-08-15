// Browser-native proof primitives shared by the extension auth client and its vectors.

const RELAY_AUTH_LABEL = "openclaw.browser-relay.auth";
export const RELAY_AUTH_VERSION = 2;

const RELAY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();

export function requireRelayCrypto(cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("WebCrypto is unavailable");
  }
  return cryptoApi;
}

function relayHexToBytes(value) {
  if (!RELAY_KEY_PATTERN.test(value)) {
    throw new Error("relay key must be 32 lowercase-hex bytes");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function relayBytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function relayBytesFromBase64Url(value, expectedLength, field) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${field} must be base64url`);
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    throw new Error(`${field} must be base64url`);
  }
  if (bytes.length !== expectedLength || relayBytesToBase64Url(bytes) !== value) {
    throw new Error(`${field} has an invalid length or encoding`);
  }
  return bytes;
}

export function randomRelayBase64Url(cryptoApi, byteLength) {
  return relayBytesToBase64Url(cryptoApi.getRandomValues(new Uint8Array(byteLength)));
}

export function extensionRelayAuthResource(relayUrl) {
  const url = new URL(relayUrl);
  const entries = [...url.searchParams];
  if (
    entries.some(([key, value]) => key !== "profile" || !/^[a-z0-9-]+$/.test(value)) ||
    entries.filter(([key]) => key === "profile").length > 1
  ) {
    throw new Error("relay URL auth resource has unsupported query parameters");
  }
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

export function canonicalRelayAuthProofBytes(proofKind, fields, clientProof) {
  if (proofKind !== "server" && proofKind !== "client" && proofKind !== "accept") {
    throw new Error("invalid relay auth proof kind");
  }
  const values = [
    RELAY_AUTH_LABEL,
    RELAY_AUTH_VERSION,
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
    if (typeof clientProof !== "string") {
      throw new Error("accept proof requires clientProof");
    }
    values.push(clientProof);
  }
  return textEncoder.encode(JSON.stringify(values));
}

export async function importRelayHmacKey(token, cryptoApi) {
  return await cryptoApi.subtle.importKey(
    "raw",
    relayHexToBytes(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function deriveRelayAuthKeyId(token, cryptoApi = globalThis.crypto) {
  const runtime = requireRelayCrypto(cryptoApi);
  const digest = await runtime.subtle.digest("SHA-256", relayHexToBytes(token));
  return relayBytesToBase64Url(new Uint8Array(digest)).slice(0, 22);
}

export async function computeRelayAuthProof(
  token,
  proofKind,
  fields,
  clientProof,
  cryptoApi = globalThis.crypto,
) {
  const runtime = requireRelayCrypto(cryptoApi);
  const key = await importRelayHmacKey(token, runtime);
  const signature = await runtime.subtle.sign(
    "HMAC",
    key,
    canonicalRelayAuthProofBytes(proofKind, fields, clientProof),
  );
  return relayBytesToBase64Url(new Uint8Array(signature));
}
