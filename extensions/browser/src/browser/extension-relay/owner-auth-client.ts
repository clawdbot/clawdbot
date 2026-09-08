import { once } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "ws";
import {
  createRelayProof,
  isCanonicalBase64UrlBytes,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayProofFields,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  parseStrictJsonObject,
} from "./auth-v2.js";
import { relayOwnerResource } from "./owner-protocol.js";

/** Never send a key or client proof until the configured listener proves its resource. */
export async function authenticateRelayOwner(params: {
  port: number;
  profile: string;
  token: string;
  signal: AbortSignal;
}): Promise<{ ws: WebSocket; owner: string }> {
  const resource = relayOwnerResource(params.port, params.profile);
  const disconnected = new AbortController();
  const signal = AbortSignal.any([
    disconnected.signal,
    params.signal,
    AbortSignal.timeout(BROWSER_RELAY_CHALLENGE_TTL_MS),
  ]);
  signal.throwIfAborted();
  const ws = new WebSocket(
    `ws://127.0.0.1:${params.port}${resource}`,
    BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
    { maxPayload: 64 * 1024 * 1024 },
  );
  ws.once("close", () =>
    disconnected.abort(new Error("Relay owner authentication connection closed")),
  );
  const abort = () => ws.terminate();
  signal.addEventListener("abort", abort, { once: true });
  // Install an error listener even when an abort wins a pending message read.
  ws.on("error", () => {});
  const read = async () => {
    const [raw] = await once(ws, "message", { signal });
    const message = parseStrictJsonObject(rawDataToString(raw));
    if (!message) {
      throw new Error("Invalid relay owner authentication frame");
    }
    return message;
  };
  try {
    await once(ws, "open", { signal });
    const clientNonce = randomRelayNonce();
    const keyId = relayKeyIdFromHex(params.token);
    const challengeRead = read();
    ws.send(JSON.stringify({ type: "auth.hello", v: 2, keyId, clientNonce }));
    const challenge = await challengeRead;
    const owner =
      typeof challenge.resource === "string"
        ? challenge.resource.slice(`${resource}&owner=`.length)
        : "";
    const now = Date.now();
    if (
      Object.keys(challenge).length !== 15 ||
      challenge.type !== "auth.challenge" ||
      challenge.v !== 2 ||
      challenge.keyId !== keyId ||
      challenge.clientNonce !== clientNonce ||
      challenge.role !== "cdp" ||
      challenge.transport !== "websocket" ||
      challenge.method !== "GET" ||
      challenge.flow !== "owner" ||
      challenge.resource !== `${resource}&owner=${owner}` ||
      !isCanonicalBase64UrlBytes(owner, 16) ||
      !isCanonicalBase64UrlBytes(challenge.instanceId, 16) ||
      !isCanonicalBase64UrlBytes(challenge.sessionId, 16) ||
      !isCanonicalBase64UrlBytes(challenge.serverNonce, 32) ||
      typeof challenge.issuedAtMs !== "number" ||
      !Number.isSafeInteger(challenge.issuedAtMs) ||
      typeof challenge.expiresAtMs !== "number" ||
      !Number.isSafeInteger(challenge.expiresAtMs) ||
      challenge.expiresAtMs <= now ||
      challenge.issuedAtMs > now + 30_000 ||
      challenge.expiresAtMs - challenge.issuedAtMs !== BROWSER_RELAY_CHALLENGE_TTL_MS
    ) {
      throw new Error("Relay owner authentication binding mismatch");
    }
    const fields: BrowserRelayProofFields = {
      keyId,
      clientNonce,
      instanceId: challenge.instanceId,
      sessionId: challenge.sessionId,
      serverNonce: challenge.serverNonce,
      issuedAtMs: challenge.issuedAtMs,
      expiresAtMs: challenge.expiresAtMs,
      role: "cdp",
      transport: "websocket",
      method: "GET",
      flow: "owner",
      resource: `${resource}&owner=${owner}`,
    };
    if (!verifyRelayProof(params.token, "server", fields, challenge.serverProof)) {
      throw new Error("Relay owner did not prove the configured key");
    }
    const clientProof = createRelayProof(params.token, "client", fields);
    const acceptedRead = read();
    ws.send(
      JSON.stringify({ type: "auth.response", v: 2, sessionId: fields.sessionId, clientProof }),
    );
    const accepted = await acceptedRead;
    if (
      Object.keys(accepted).length !== 4 ||
      accepted.type !== "auth.ok" ||
      accepted.v !== 2 ||
      accepted.sessionId !== fields.sessionId ||
      !verifyRelayProof(params.token, "accept", fields, accepted.acceptProof, clientProof)
    ) {
      throw new Error("Relay owner acceptance proof failed");
    }
    signal.throwIfAborted();
    return { ws, owner };
  } catch (error) {
    ws.terminate();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
