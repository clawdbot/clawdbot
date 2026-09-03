import { describe, expect, it, vi } from "vitest";
import {
  createRelayProof,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayProofFields,
} from "./auth-v2-crypto.js";
import {
  BrowserRelayAuthV2Authority,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseExtensionRelayResource,
  parseRelayAuthHello,
  parseRelayAuthResponse,
  parseStrictJsonObject,
} from "./auth-v2.js";

const KEY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
const SOURCE = "127.0.0.1";
const VECTOR_FIELDS: BrowserRelayProofFields = {
  keyId: "Yw3NKWbEM2aRElRIu7JbT_",
  instanceId: "EREREREREREREREREREREQ",
  sessionId: "IiIiIiIiIiIiIiIiIiIiIg",
  clientNonce: "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM",
  serverNonce: "REREREREREREREREREREREREREREREREREREREREREQ",
  issuedAtMs: 1_786_123_456_000,
  expiresAtMs: 1_786_123_466_000,
  role: "extension",
  transport: "websocket",
  method: "GET",
  resource: "/extension?profile=chrome",
  flow: "extension",
};

const BINDING = {
  role: "extension",
  transport: "websocket",
  method: "GET",
  resource: "/extension",
  flow: "extension",
} as const;

function hello(clientNonce = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM") {
  return {
    type: "auth.hello" as const,
    v: 2 as const,
    keyId: relayKeyIdFromHex(KEY),
    clientNonce,
  };
}

describe("browser relay auth v2 proofs", () => {
  it("matches the frozen Node/WebCrypto test vector", () => {
    expect(relayKeyIdFromHex(KEY)).toBe(VECTOR_FIELDS.keyId);
    expect(createRelayProof(KEY, "server", VECTOR_FIELDS)).toBe(
      "ynhaAA_l2HkOGXQ8DvIWfzWwwGjDcV93aumHNe_NM-Q",
    );
    const clientProof = createRelayProof(KEY, "client", VECTOR_FIELDS);
    expect(clientProof).toBe("Rl8TStMYlPLxJPDYwSe__mtEjgMf1C4TM-ZN6sUipZ4");
    expect(createRelayProof(KEY, "accept", VECTOR_FIELDS, clientProof)).toBe(
      "1R5MpHs6qnAdc0_X6vKBwj91tlRoWfNuGXaNfSD7VnI",
    );
  });

  it.each([
    ["keyId", "EREREREREREREREREREREQ"],
    ["instanceId", "IiIiIiIiIiIiIiIiIiIiIg"],
    ["sessionId", "EREREREREREREREREREREQ"],
    ["clientNonce", "REREREREREREREREREREREREREREREREREREREREREQ"],
    ["serverNonce", "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"],
    ["issuedAtMs", VECTOR_FIELDS.issuedAtMs + 1],
    ["expiresAtMs", VECTOR_FIELDS.expiresAtMs + 1],
    ["role", "cdp"],
    ["transport", "connection"],
    ["method", "SEQUENCE"],
    ["resource", "/extension"],
    ["flow", "cdp"],
  ] as const)("binds %s", (field, replacement) => {
    const proof = createRelayProof(KEY, "server", VECTOR_FIELDS);
    expect(verifyRelayProof(KEY, "server", { ...VECTOR_FIELDS, [field]: replacement }, proof)).toBe(
      false,
    );
  });

  it("rejects malformed or wrong-length proofs before constant-time comparison", () => {
    expect(verifyRelayProof(KEY, "server", VECTOR_FIELDS, "short")).toBe(false);
    expect(verifyRelayProof(KEY, "server", VECTOR_FIELDS, "!".repeat(43))).toBe(false);
  });
});

describe("BrowserRelayAuthV2Authority", () => {
  it("binds completion to the exact connection and consumes it atomically", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const socket = {};
    const otherSocket = {};
    expect(authority.registerPendingConnection(socket, vi.fn(), SOURCE)).toBe(true);
    expect(authority.registerPendingConnection(otherSocket, vi.fn(), SOURCE)).toBe(true);
    const challenge = authority.issueChallenge(socket, hello(), BINDING, 1_000);
    expect(challenge).not.toBeNull();
    const fields = challenge as BrowserRelayProofFields;
    const response = {
      type: "auth.response",
      v: 2,
      sessionId: fields.sessionId,
      clientProof: createRelayProof(KEY, "client", fields),
    } as const;
    expect(authority.completeChallenge(otherSocket, response, 1_001)).toBeNull();
    expect(authority.completeChallenge(socket, response, 1_001)?.ok.type).toBe("auth.ok");
    expect(authority.completeChallenge(socket, response, 1_001)).toBeNull();
    expect(authority.issueChallenge(socket, hello(), BINDING, 1_002)).toBeNull();
  });

  it("rejects replayed hello across the same or another socket until expiry", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const first = {};
    const second = {};
    authority.registerPendingConnection(first, vi.fn(), SOURCE);
    authority.registerPendingConnection(second, vi.fn(), SOURCE);
    expect(authority.issueChallenge(first, hello(), BINDING, 1_000)).not.toBeNull();
    expect(authority.issueChallenge(first, hello(), BINDING, 1_001)).toBeNull();
    expect(authority.issueChallenge(second, hello(), BINDING, 1_001)).toBeNull();
    expect(authority.issueChallenge(second, hello(), BINDING, 11_001)).not.toBeNull();
  });

  it("rejects expired challenges and wrong client proofs", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const first = {};
    authority.registerPendingConnection(first, vi.fn(), SOURCE);
    const expired = authority.issueChallenge(first, hello(), BINDING, 1_000);
    expect(expired).not.toBeNull();
    expect(
      authority.completeChallenge(
        first,
        {
          type: "auth.response",
          v: 2,
          sessionId: expired!.sessionId,
          clientProof: createRelayProof(KEY, "client", expired!),
        },
        11_001,
      ),
    ).toBeNull();

    const second = {};
    authority.registerPendingConnection(second, vi.fn(), SOURCE);
    const challenge = authority.issueChallenge(
      second,
      hello("REREREREREREREREREREREREREREREREREREREREREQ"),
      BINDING,
      20_000,
    );
    expect(challenge).not.toBeNull();
    expect(
      authority.completeChallenge(
        second,
        {
          type: "auth.response",
          v: 2,
          sessionId: challenge!.sessionId,
          clientProof: "A".repeat(43),
        },
        20_001,
      ),
    ).toBeNull();
  });

  it("invalidates pending and authenticated connections exactly once on rotation", () => {
    invalidateBrowserRelayAuthV2Authority();
    const pendingInvalidated = vi.fn();
    const authenticatedInvalidated = vi.fn();
    const pending = {};
    const authenticated = {};
    const first = getBrowserRelayAuthV2Authority(KEY);
    first.registerPendingConnection(pending, pendingInvalidated, SOURCE);
    first.registerAuthenticatedConnection(authenticated, authenticatedInvalidated);
    expect(first.issueChallenge(pending, hello(), BINDING, 1_000)).not.toBeNull();
    const rotated = getBrowserRelayAuthV2Authority("f".repeat(64));
    expect(rotated).not.toBe(first);
    expect(pendingInvalidated).toHaveBeenCalledOnce();
    expect(authenticatedInvalidated).toHaveBeenCalledOnce();
    expect(first.issueChallenge(pending, hello(), BINDING, 1_001)).toBeNull();
    first.dispose();
    expect(pendingInvalidated).toHaveBeenCalledOnce();
    expect(authenticatedInvalidated).toHaveBeenCalledOnce();
    invalidateBrowserRelayAuthV2Authority();
  });

  it("reserves pending admission for independent sources within the global bound", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const attackerInvalidators = Array.from({ length: 128 }, () => vi.fn());
    const attackerBindings = attackerInvalidators.map(() => ({}));
    const attackerAdmissions = attackerBindings.map((binding, index) =>
      authority.registerPendingConnection(binding, attackerInvalidators[index]!, "198.51.100.10"),
    );
    expect(attackerAdmissions.filter(Boolean)).toHaveLength(32);

    const independent = {};
    expect(authority.registerPendingConnection(independent, vi.fn(), "203.0.113.20")).toBe(true);
    const challenge = authority.issueChallenge(independent, hello(), BINDING, 1_000)!;
    expect(
      authority.completeChallenge(
        independent,
        {
          type: "auth.response",
          v: 2,
          sessionId: challenge.sessionId,
          clientProof: createRelayProof(KEY, "client", challenge),
        },
        1_001,
      )?.ok.type,
    ).toBe("auth.ok");

    for (let index = 0; index < 96; index += 1) {
      expect(authority.registerPendingConnection({}, vi.fn(), `192.0.2.${index}`)).toBe(true);
    }
    expect(authority.registerPendingConnection({}, vi.fn(), "203.0.113.21")).toBe(false);

    const active = {};
    const activeInvalidated = vi.fn();
    expect(authority.registerAuthenticatedConnection(active, activeInvalidated)).toBe(true);
    expect(activeInvalidated).not.toHaveBeenCalled();
    expect(attackerInvalidators.every((invalidate) => !invalidate.mock.calls.length)).toBe(true);

    authority.releaseConnection(attackerBindings[0]!);
    expect(authority.registerPendingConnection({}, vi.fn(), "198.51.100.10")).toBe(true);
  });

  it("counts loopback aliases as one pending source", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    for (let index = 0; index < 32; index += 1) {
      expect(authority.registerPendingConnection({}, vi.fn(), "127.0.0.2")).toBe(true);
    }
    expect(authority.registerPendingConnection({}, vi.fn(), "127.0.0.3")).toBe(false);
    expect(authority.registerPendingConnection({}, vi.fn(), "::ffff:127.0.0.4")).toBe(false);
    expect(authority.registerPendingConnection({}, vi.fn(), "::1")).toBe(false);
  });

  it("counts loopback aliases as one replay source", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    for (let index = 0; index < 256; index += 1) {
      const connection = {};
      expect(
        authority.registerPendingConnection(connection, vi.fn(), `127.0.0.${2 + (index % 2)}`),
      ).toBe(true);
      const nonce = Buffer.alloc(32);
      nonce.writeUInt32BE(index, 28);
      expect(
        authority.issueChallenge(connection, hello(nonce.toString("base64url")), BINDING, 1_000),
      ).not.toBeNull();
      authority.releaseConnection(connection);
    }
    const overflow = {};
    expect(authority.registerPendingConnection(overflow, vi.fn(), "::1")).toBe(true);
    expect(
      authority.issueChallenge(
        overflow,
        hello(Buffer.alloc(32, 0xff).toString("base64url")),
        BINDING,
        1_000,
      ),
    ).toBeNull();
  });

  it("rejects promotion at active capacity without disturbing active connections", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const pending = {};
    const pendingInvalidated = vi.fn();
    expect(authority.registerPendingConnection(pending, pendingInvalidated, SOURCE)).toBe(true);
    const challenge = authority.issueChallenge(pending, hello(), BINDING, 1_000);
    expect(challenge).not.toBeNull();

    const activeInvalidators = Array.from({ length: 128 }, () => vi.fn());
    const activeBindings = activeInvalidators.map(() => ({}));
    for (const [index, binding] of activeBindings.entries()) {
      expect(authority.registerAuthenticatedConnection(binding, activeInvalidators[index]!)).toBe(
        true,
      );
    }
    expect(
      authority.completeChallenge(
        pending,
        {
          type: "auth.response",
          v: 2,
          sessionId: challenge!.sessionId,
          clientProof: createRelayProof(KEY, "client", challenge!),
        },
        1_001,
      ),
    ).toBeNull();
    expect(pendingInvalidated).not.toHaveBeenCalled();
    expect(activeInvalidators.every((invalidate) => !invalidate.mock.calls.length)).toBe(true);

    authority.releaseConnection(activeBindings[0]!);
    expect(authority.registerAuthenticatedConnection({}, vi.fn())).toBe(true);
    authority.releaseConnection(pending);
    expect(authority.issueChallenge(pending, hello(), BINDING, 1_002)).toBeNull();
  });

  it("cleans failed and expired pending proofs without affecting active connections", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    const active = {};
    const activeInvalidated = vi.fn();
    authority.registerAuthenticatedConnection(active, activeInvalidated);

    const failed = {};
    authority.registerPendingConnection(failed, vi.fn(), SOURCE);
    const failedChallenge = authority.issueChallenge(failed, hello(), BINDING, 1_000)!;
    expect(
      authority.completeChallenge(
        failed,
        {
          type: "auth.response",
          v: 2,
          sessionId: failedChallenge.sessionId,
          clientProof: "A".repeat(43),
        },
        1_001,
      ),
    ).toBeNull();
    authority.releaseConnection(failed);

    const expired = {};
    authority.registerPendingConnection(expired, vi.fn(), SOURCE);
    const expiredChallenge = authority.issueChallenge(
      expired,
      hello("REREREREREREREREREREREREREREREREREREREREREQ"),
      BINDING,
      2_000,
    )!;
    expect(
      authority.completeChallenge(
        expired,
        {
          type: "auth.response",
          v: 2,
          sessionId: expiredChallenge.sessionId,
          clientProof: createRelayProof(KEY, "client", expiredChallenge),
        },
        12_001,
      ),
    ).toBeNull();
    authority.releaseConnection(expired);
    expect(activeInvalidated).not.toHaveBeenCalled();
    expect(authority.registerPendingConnection({}, vi.fn(), SOURCE)).toBe(true);
  });

  it("fails closed at the bounded replay-cache limit", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    for (let index = 0; index < 1_024; index += 1) {
      const connection = {};
      authority.registerPendingConnection(connection, vi.fn(), `192.0.2.${index}`);
      const nonce = Buffer.alloc(32);
      nonce.writeUInt32BE(index, 28);
      expect(
        authority.issueChallenge(connection, hello(nonce.toString("base64url")), BINDING, 1_000),
      ).not.toBeNull();
      authority.releaseConnection(connection);
    }
    const overflow = {};
    authority.registerPendingConnection(overflow, vi.fn(), SOURCE);
    expect(
      authority.issueChallenge(
        overflow,
        hello(Buffer.alloc(32, 0xff).toString("base64url")),
        BINDING,
        1_000,
      ),
    ).toBeNull();
  });

  it("reserves replay capacity for independent sources during reconnect churn", () => {
    const authority = new BrowserRelayAuthV2Authority(KEY);
    for (let index = 0; index < 256; index += 1) {
      const connection = {};
      authority.registerPendingConnection(connection, vi.fn(), "198.51.100.10");
      const nonce = Buffer.alloc(32);
      nonce.writeUInt32BE(index, 28);
      expect(
        authority.issueChallenge(connection, hello(nonce.toString("base64url")), BINDING, 1_000),
      ).not.toBeNull();
      authority.releaseConnection(connection);
    }

    const sameSource = {};
    authority.registerPendingConnection(sameSource, vi.fn(), "198.51.100.10");
    expect(
      authority.issueChallenge(
        sameSource,
        hello(Buffer.alloc(32, 0xfe).toString("base64url")),
        BINDING,
        1_000,
      ),
    ).toBeNull();

    const independent = {};
    authority.registerPendingConnection(independent, vi.fn(), "203.0.113.20");
    expect(
      authority.issueChallenge(
        independent,
        hello(Buffer.alloc(32, 0xff).toString("base64url")),
        BINDING,
        1_000,
      ),
    ).not.toBeNull();
  });
});

describe("browser relay auth v2 wire validation", () => {
  it("accepts only exact hello and response shapes", () => {
    expect(parseRelayAuthHello(hello())).toEqual(hello());
    expect(parseRelayAuthHello({ ...hello(), extra: true })).toBeNull();
    expect(parseRelayAuthHello({ ...hello(), v: 1 })).toBeNull();
    expect(
      parseRelayAuthResponse({
        type: "auth.response",
        v: 2,
        sessionId: "EREREREREREREREREREREQ",
        clientProof: "A".repeat(43),
      }),
    ).not.toBeNull();
  });

  it("canonicalizes only the exact path and optional profile query", () => {
    expect(parseExtensionRelayResource("/extension", "/extension")).toBe("/extension");
    expect(parseExtensionRelayResource("/extension?profile=chrome", "/extension")).toBe(
      "/extension?profile=chrome",
    );
    expect(parseExtensionRelayResource("/extension?x=1", "/extension")).toBeNull();
    expect(parseExtensionRelayResource("/extension?profile=a&profile=b", "/extension")).toBeNull();
    expect(parseExtensionRelayResource("/other", "/extension")).toBeNull();
  });

  it("detects duplicate security fields before JSON parsing", () => {
    expect(parseStrictJsonObject('{"v":2,"v":1}')).toBeNull();
    expect(parseStrictJsonObject('{"outer":{"v":2,"v":1}}')).toBeNull();
    expect(parseStrictJsonObject('{"a":1,"nested":{"a":2}}')).not.toBeNull();
  });
});
