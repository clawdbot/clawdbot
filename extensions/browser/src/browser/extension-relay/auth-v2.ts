import {
  BROWSER_RELAY_AUTH_VERSION,
  createRelayProof,
  isBase64UrlText,
  isCanonicalBase64UrlBytes,
  randomRelayId,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayAuthChallenge,
  type BrowserRelayAuthOk,
  type BrowserRelayProofFields,
} from "./auth-v2-crypto.js";

export const BROWSER_RELAY_EXTENSION_SUBPROTOCOL = "openclaw-extension-relay.v2";
export const BROWSER_RELAY_AUTH_CHALLENGE_PATH = "/_openclaw/relay/auth/v2/challenge";
export const BROWSER_RELAY_AUTH_COMPLETE_PATH = "/_openclaw/relay/auth/v2/complete";
export const BROWSER_RELAY_CHALLENGE_TTL_MS = 10_000;

const MAX_PENDING_AUTH_CONNECTIONS = 128;
const MAX_AUTHENTICATED_CONNECTIONS = 128;
const MAX_REPLAY_ENTRIES = 1_024;

type BrowserRelayAuthHello = {
  type: "auth.hello";
  v: 2;
  keyId: string;
  clientNonce: string;
};

type BrowserRelayAuthResponse = {
  type: "auth.response";
  v: 2;
  sessionId: string;
  clientProof: string;
};

type BrowserRelayHttpChallengeRequest = {
  v: 2;
  keyId: string;
  clientNonce: string;
  role: "cdp";
  transport: "connection";
  method: "SEQUENCE" | "GET";
  resource: "/json/version -> /cdp" | "/json/list";
  flow: "cdp" | "json-list";
};

type BrowserRelayHttpCompleteRequest = {
  v: 2;
  sessionId: string;
  clientProof: string;
};

type BrowserRelayBinding = Pick<
  BrowserRelayProofFields,
  "role" | "transport" | "method" | "resource" | "flow"
>;

type ChallengeState = {
  binding: object;
  fields: BrowserRelayProofFields;
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseRelayAuthHello(value: unknown): BrowserRelayAuthHello | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["type", "v", "keyId", "clientNonce"]) ||
    record.type !== "auth.hello" ||
    record.v !== BROWSER_RELAY_AUTH_VERSION ||
    typeof record.keyId !== "string" ||
    record.keyId.length !== 22 ||
    !isBase64UrlText(record.keyId) ||
    !isCanonicalBase64UrlBytes(record.clientNonce, 32)
  ) {
    return null;
  }
  return record as BrowserRelayAuthHello;
}

export function parseRelayAuthResponse(value: unknown): BrowserRelayAuthResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["type", "v", "sessionId", "clientProof"]) ||
    record.type !== "auth.response" ||
    record.v !== BROWSER_RELAY_AUTH_VERSION ||
    !isCanonicalBase64UrlBytes(record.sessionId, 16) ||
    !isCanonicalBase64UrlBytes(record.clientProof, 32)
  ) {
    return null;
  }
  return record as BrowserRelayAuthResponse;
}

export function parseRelayHttpChallengeRequest(
  value: unknown,
): BrowserRelayHttpChallengeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "v",
      "keyId",
      "clientNonce",
      "role",
      "transport",
      "method",
      "resource",
      "flow",
    ]) ||
    record.v !== BROWSER_RELAY_AUTH_VERSION ||
    typeof record.keyId !== "string" ||
    record.keyId.length !== 22 ||
    !isBase64UrlText(record.keyId) ||
    !isCanonicalBase64UrlBytes(record.clientNonce, 32) ||
    record.role !== "cdp" ||
    record.transport !== "connection" ||
    !(
      (record.flow === "cdp" &&
        record.method === "SEQUENCE" &&
        record.resource === "/json/version -> /cdp") ||
      (record.flow === "json-list" && record.method === "GET" && record.resource === "/json/list")
    )
  ) {
    return null;
  }
  return record as BrowserRelayHttpChallengeRequest;
}

export function parseRelayHttpCompleteRequest(
  value: unknown,
): BrowserRelayHttpCompleteRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["v", "sessionId", "clientProof"]) ||
    record.v !== BROWSER_RELAY_AUTH_VERSION ||
    !isCanonicalBase64UrlBytes(record.sessionId, 16) ||
    !isCanonicalBase64UrlBytes(record.clientProof, 32)
  ) {
    return null;
  }
  return record as BrowserRelayHttpCompleteRequest;
}

export function parseExtensionRelayResource(rawUrl: string, expectedPath: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (url.pathname !== expectedPath || url.hash) {
    return null;
  }
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key]) => key !== "profile") || url.searchParams.getAll("profile").length > 1) {
    return null;
  }
  const profile = url.searchParams.get("profile");
  if (profile !== null && !/^[a-z0-9-]+$/u.test(profile)) {
    return null;
  }
  return profile === null ? expectedPath : `${expectedPath}?profile=${encodeURIComponent(profile)}`;
}

/** Reject duplicate object keys before JSON.parse can silently keep the last value. */
function hasDuplicateJsonObjectKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectingKey = false;
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[index] ?? "")) {
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
        let key: unknown;
        try {
          key = JSON.parse(text.slice(start, index));
        } catch {
          return false;
        }
        skipWhitespace();
        if (text[index] === ":" && typeof key === "string") {
          const keys = stack.at(-1) as Set<string>;
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

export function parseStrictJsonObject(text: string): Record<string, unknown> | null {
  if (hasDuplicateJsonObjectKeys(text)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

class BoundedReplayCache {
  private readonly entries = new Map<string, number>();

  reserve(key: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [candidate, expiry] of this.entries) {
      if (expiry < nowMs) {
        this.entries.delete(candidate);
      }
    }
    if (this.entries.has(key) || this.entries.size >= MAX_REPLAY_ENTRIES) {
      return false;
    }
    this.entries.set(key, expiresAtMs);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}

export class BrowserRelayAuthV2Authority {
  readonly keyId: string;
  readonly instanceId = randomRelayId();
  private readonly challenges = new Map<string, ChallengeState>();
  private readonly pendingConnections = new Map<object, () => void>();
  private readonly authenticatedConnections = new Map<object, () => void>();
  private readonly replay = new BoundedReplayCache();
  private disposed = false;

  constructor(private readonly keyHex: string) {
    this.keyId = relayKeyIdFromHex(keyHex);
  }

  registerPendingConnection(binding: object, onInvalidate: () => void): boolean {
    if (
      this.disposed ||
      this.pendingConnections.has(binding) ||
      this.authenticatedConnections.has(binding) ||
      this.pendingConnections.size >= MAX_PENDING_AUTH_CONNECTIONS
    ) {
      return false;
    }
    this.pendingConnections.set(binding, onInvalidate);
    return true;
  }

  registerAuthenticatedConnection(binding: object, onInvalidate: () => void): boolean {
    if (
      this.disposed ||
      this.pendingConnections.has(binding) ||
      this.authenticatedConnections.has(binding) ||
      this.authenticatedConnections.size >= MAX_AUTHENTICATED_CONNECTIONS
    ) {
      return false;
    }
    this.authenticatedConnections.set(binding, onInvalidate);
    return true;
  }

  releaseConnection(binding: object): void {
    this.pendingConnections.delete(binding);
    this.authenticatedConnections.delete(binding);
    for (const [sessionId, challenge] of this.challenges) {
      if (challenge.binding === binding) {
        this.challenges.delete(sessionId);
      }
    }
  }

  issueChallenge(
    binding: object,
    hello: BrowserRelayAuthHello,
    expected: BrowserRelayBinding,
    nowMs = Date.now(),
  ): BrowserRelayAuthChallenge | null {
    if (
      this.disposed ||
      !this.pendingConnections.has(binding) ||
      hello.keyId !== this.keyId ||
      this.challenges.size >= MAX_PENDING_AUTH_CONNECTIONS
    ) {
      return null;
    }
    const expiresAtMs = nowMs + BROWSER_RELAY_CHALLENGE_TTL_MS;
    if (!this.replay.reserve(`${this.keyId}:${hello.clientNonce}`, expiresAtMs, nowMs)) {
      return null;
    }
    const fields: BrowserRelayProofFields = {
      keyId: this.keyId,
      instanceId: this.instanceId,
      sessionId: randomRelayId(),
      clientNonce: hello.clientNonce,
      serverNonce: randomRelayNonce(),
      issuedAtMs: nowMs,
      expiresAtMs,
      ...expected,
    };
    this.challenges.set(fields.sessionId, { binding, fields });
    return {
      type: "auth.challenge",
      v: BROWSER_RELAY_AUTH_VERSION,
      ...fields,
      serverProof: createRelayProof(this.keyHex, "server", fields),
    };
  }

  completeChallenge(
    binding: object,
    response: BrowserRelayAuthResponse,
    nowMs = Date.now(),
  ): { ok: BrowserRelayAuthOk; fields: BrowserRelayProofFields } | null {
    const challenge = this.challenges.get(response.sessionId);
    if (!challenge || challenge.binding !== binding || this.disposed) {
      return null;
    }
    // The exact socket owns one attempt. Consume before proof verification so
    // duplicate completion cannot race a successful verification.
    this.challenges.delete(response.sessionId);
    if (
      nowMs > challenge.fields.expiresAtMs ||
      !verifyRelayProof(this.keyHex, "client", challenge.fields, response.clientProof)
    ) {
      return null;
    }
    const invalidate = this.pendingConnections.get(binding);
    if (!invalidate || this.authenticatedConnections.size >= MAX_AUTHENTICATED_CONNECTIONS) {
      return null;
    }
    // Promotion is synchronous and moves the exact binding between disjoint
    // registries, so pending admission can never consume active capacity.
    this.pendingConnections.delete(binding);
    this.authenticatedConnections.set(binding, invalidate);
    return {
      fields: challenge.fields,
      ok: {
        type: "auth.ok",
        v: BROWSER_RELAY_AUTH_VERSION,
        sessionId: challenge.fields.sessionId,
        acceptProof: createRelayProof(
          this.keyHex,
          "accept",
          challenge.fields,
          response.clientProof,
        ),
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const invalidators = [
      ...this.pendingConnections.values(),
      ...this.authenticatedConnections.values(),
    ];
    this.pendingConnections.clear();
    this.authenticatedConnections.clear();
    this.challenges.clear();
    this.replay.clear();
    for (const invalidate of invalidators) {
      invalidate();
    }
  }
}

let activeAuthority: { keyHex: string; authority: BrowserRelayAuthV2Authority } | null = null;

/** One process-wide replay/session authority for the current host key. */
export function getBrowserRelayAuthV2Authority(keyHex: string): BrowserRelayAuthV2Authority {
  if (activeAuthority?.keyHex === keyHex) {
    return activeAuthority.authority;
  }
  activeAuthority?.authority.dispose();
  const authority = new BrowserRelayAuthV2Authority(keyHex);
  activeAuthority = { keyHex, authority };
  return authority;
}

export function invalidateBrowserRelayAuthV2Authority(): void {
  activeAuthority?.authority.dispose();
  activeAuthority = null;
}
