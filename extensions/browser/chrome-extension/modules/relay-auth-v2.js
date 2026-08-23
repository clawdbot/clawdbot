// Browser Relay Authentication v2 for the unpacked MV3 extension.
// This module is intentionally browser-native ESM: no Node globals or bundling.

import {
  RELAY_AUTH_VERSION,
  canonicalRelayAuthProofBytes,
  computeRelayAuthProof,
  deriveRelayAuthKeyId,
  extensionRelayAuthResource,
  importRelayHmacKey,
  randomRelayBase64Url,
  relayBytesFromBase64Url,
  requireRelayCrypto,
} from "./relay-auth-v2-crypto.js";

export const EXTENSION_RELAY_V2_PROTOCOL = "openclaw-extension-relay.v2";

const CHALLENGE_LIFETIME_MS = 10_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_AUTH_JSON_BYTES = 16 * 1024;
const authTextEncoder = new TextEncoder();

const CHALLENGE_KEYS = [
  "type",
  "v",
  "keyId",
  "instanceId",
  "sessionId",
  "clientNonce",
  "serverNonce",
  "issuedAtMs",
  "expiresAtMs",
  "role",
  "transport",
  "method",
  "resource",
  "flow",
  "serverProof",
];
const OK_KEYS = ["type", "v", "sessionId", "acceptProof"];

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).toSorted((a, b) => a.localeCompare(b));
  const wanted = [...expected].toSorted((a, b) => a.localeCompare(b));
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasDuplicateJsonObjectKeys(text) {
  const stack = [];
  let expectingKey = false;
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) {
      index += 1;
    }
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const next = text[index++];
        if (escaped) {
          escaped = false;
        } else if (next === "\\") {
          escaped = true;
        } else if (next === '"') {
          break;
        }
      }
      if (expectingKey && stack.at(-1)) {
        let key;
        try {
          key = JSON.parse(text.slice(start, index));
        } catch {
          return false;
        }
        skipWhitespace();
        if (text[index] === ":" && typeof key === "string") {
          const keys = stack.at(-1);
          if (keys.has(key)) {
            return true;
          }
          keys.add(key);
          expectingKey = false;
        }
      }
      continue;
    }
    if (char === "{") {
      stack.push(new Set());
      expectingKey = true;
    } else if (char === "[") {
      stack.push(null);
      expectingKey = false;
    } else if (char === "}") {
      stack.pop();
      expectingKey = false;
    } else if (char === "]") {
      stack.pop();
      expectingKey = false;
    } else if (char === ",") {
      expectingKey = stack.at(-1) instanceof Set;
    }
    index += 1;
  }
  return false;
}

/** Parse an authentication frame without allowing JSON duplicate-key shadowing. */
export function parseRelayAuthJson(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > MAX_AUTH_JSON_BYTES ||
    authTextEncoder.encode(raw).byteLength > MAX_AUTH_JSON_BYTES ||
    hasDuplicateJsonObjectKeys(raw)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertSafeTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

/**
 * One connection-bound client state machine. Any invalid or out-of-order
 * security frame permanently fails this instance; callers must close the socket.
 */
export async function createExtensionRelayAuthClient({
  token,
  relayUrl,
  cryptoApi = globalThis.crypto,
  now = () => Date.now(),
  clientNonce,
}) {
  const runtime = requireRelayCrypto(cryptoApi);
  const keyId = await deriveRelayAuthKeyId(token, runtime);
  const key = await importRelayHmacKey(token, runtime);
  const nonce = clientNonce ?? randomRelayBase64Url(runtime, 32);
  relayBytesFromBase64Url(nonce, 32, "clientNonce");
  const resource = extensionRelayAuthResource(relayUrl);
  let state = "new";
  let challenge = null;
  let clientProof = null;

  const fail = (error) => {
    state = "failed";
    throw error instanceof Error ? error : new Error(String(error));
  };

  return {
    keyId,
    clientNonce: nonce,
    get authenticated() {
      return state === "authenticated";
    },
    start() {
      if (state !== "new") {
        return fail(new Error("relay auth hello is out of sequence"));
      }
      state = "waiting-challenge";
      return { type: "auth.hello", v: RELAY_AUTH_VERSION, keyId, clientNonce: nonce };
    },
    async acceptChallenge(message) {
      if (state !== "waiting-challenge") {
        return fail(new Error("relay auth challenge is out of sequence"));
      }
      state = "verifying-challenge";
      try {
        if (!hasExactKeys(message, CHALLENGE_KEYS) || message.type !== "auth.challenge") {
          throw new Error("invalid relay auth challenge shape");
        }
        if (
          message.v !== RELAY_AUTH_VERSION ||
          message.keyId !== keyId ||
          message.clientNonce !== nonce ||
          message.role !== "extension" ||
          message.transport !== "websocket" ||
          message.method !== "GET" ||
          message.resource !== resource ||
          message.flow !== "extension"
        ) {
          throw new Error("relay auth challenge binding mismatch");
        }
        relayBytesFromBase64Url(message.instanceId, 16, "instanceId");
        relayBytesFromBase64Url(message.sessionId, 16, "sessionId");
        relayBytesFromBase64Url(message.serverNonce, 32, "serverNonce");
        const serverProofBytes = relayBytesFromBase64Url(message.serverProof, 32, "serverProof");
        assertSafeTimestamp(message.issuedAtMs, "issuedAtMs");
        assertSafeTimestamp(message.expiresAtMs, "expiresAtMs");
        const currentTime = now();
        assertSafeTimestamp(currentTime, "current time");
        if (
          message.expiresAtMs <= message.issuedAtMs ||
          message.expiresAtMs - message.issuedAtMs > CHALLENGE_LIFETIME_MS ||
          Math.abs(currentTime - message.issuedAtMs) > MAX_CLOCK_SKEW_MS ||
          currentTime > message.expiresAtMs
        ) {
          throw new Error("relay auth challenge is expired or outside the allowed clock skew");
        }
        const fields = {
          keyId: message.keyId,
          instanceId: message.instanceId,
          sessionId: message.sessionId,
          clientNonce: message.clientNonce,
          serverNonce: message.serverNonce,
          issuedAtMs: message.issuedAtMs,
          expiresAtMs: message.expiresAtMs,
          role: message.role,
          transport: message.transport,
          method: message.method,
          resource: message.resource,
          flow: message.flow,
        };
        const valid = await runtime.subtle.verify(
          "HMAC",
          key,
          serverProofBytes,
          canonicalRelayAuthProofBytes("server", fields),
        );
        if (!valid) {
          throw new Error("relay auth server proof is invalid");
        }
        clientProof = await computeRelayAuthProof(token, "client", fields, undefined, runtime);
        challenge = fields;
        state = "waiting-ok";
        return {
          type: "auth.response",
          v: RELAY_AUTH_VERSION,
          sessionId: fields.sessionId,
          clientProof,
        };
      } catch (error) {
        return fail(error);
      }
    },
    async acceptOk(message) {
      if (state !== "waiting-ok" || !challenge || !clientProof) {
        return fail(new Error("relay auth ok is out of sequence"));
      }
      state = "verifying-ok";
      try {
        if (
          !hasExactKeys(message, OK_KEYS) ||
          message.type !== "auth.ok" ||
          message.v !== RELAY_AUTH_VERSION ||
          message.sessionId !== challenge.sessionId
        ) {
          throw new Error("invalid relay auth ok binding");
        }
        const acceptProofBytes = relayBytesFromBase64Url(message.acceptProof, 32, "acceptProof");
        const valid = await runtime.subtle.verify(
          "HMAC",
          key,
          acceptProofBytes,
          canonicalRelayAuthProofBytes("accept", challenge, clientProof),
        );
        if (!valid) {
          throw new Error("relay auth accept proof is invalid");
        }
        state = "authenticated";
        return undefined;
      } catch (error) {
        return fail(error);
      }
    },
  };
}
