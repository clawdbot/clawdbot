/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  revokeDeviceToken,
  rotateDeviceToken,
  storeDeviceAuthToken,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createState(request: (method: string, params?: unknown) => Promise<unknown>) {
  return {
    client: {
      request: request as <T = unknown>(method: string, params?: unknown) => Promise<T>,
    },
    connected: true,
    requestGeneration: 1,
    devicesLoading: false,
    devicesQueuedRefresh: "none" as const,
    devicesError: null as string | null,
    devicesList: null,
  };
}

function storeIdentity() {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({
      version: 1,
      deviceId: "00",
      publicKey: "AA",
      privateKey: "AA",
      createdAtMs: 1,
    }),
  );
}

function deferIdentityFingerprint() {
  const digest = deferred<ArrayBuffer>();
  const digestMock = vi.fn(() => digest.promise);
  vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
  return { digest, digestMock };
}

const tokenParams = {
  deviceId: "00",
  gatewayUrl: "wss://gateway.test",
  role: "operator",
};

// Every Gateway answering this method returns the full result schema for the requested grant.
// Cases spread this base so each one fails for the reason it names rather than for a required
// field the fixture happened to omit.
const rotationResult = {
  deviceId: tokenParams.deviceId,
  role: tokenParams.role,
  scopes: [],
  rotatedAtMs: 1_700_000_000_000,
};

function storedTokenKey(): string {
  const key = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).find((candidate) => candidate?.startsWith("openclaw.device.auth.v1:"));
  if (!key) {
    throw new Error("missing device-auth test storage key");
  }
  return key;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device token request lifecycle", () => {
  // A retired epoch is a reconnect, not a reason to destroy the credential: the previous
  // token is already dead on the server, so the caller still needs this one to recover.
  it("returns a rotate response from a retired request epoch without persisting it", async () => {
    const response = deferred<unknown>();
    const state = createState(() => response.promise);

    const operation = rotateDeviceToken(state, tokenParams);
    state.requestGeneration += 1;
    response.resolve({ token: "rotated-token", tokenDelivery: "in-band", ...rotationResult });

    expect(await operation).toEqual({ delivery: "in-band", token: "rotated-token" });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("rechecks rotate ownership after loading the local identity", async () => {
    storeIdentity();
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({
      token: "rotated-token",
      tokenDelivery: "in-band",
      ...rotationResult,
    }));

    const operation = rotateDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);

    expect(await operation).toEqual({ delivery: "in-band", token: "rotated-token" });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("reports a cross-device rotation the Gateway withheld the token for", async () => {
    const state = createState(async () => ({
      ...rotationResult,
      tokenDelivery: "withheld-cross-device",
    }));

    expect(await rotateDeviceToken(state, tokenParams)).toEqual({
      delivery: "withheld-cross-device",
    });
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  // The Gateway echoes the raw request deviceId and its own stored role, so a grant that
  // differs only by surrounding whitespace is still the one this page asked to rotate.
  it("accepts a result whose grant differs from the request only by whitespace", async () => {
    const state = createState(async () => ({
      ...rotationResult,
      deviceId: " 00 ",
      role: "operator ",
      tokenDelivery: "withheld-cross-device",
    }));

    expect(await rotateDeviceToken(state, tokenParams)).toEqual({
      delivery: "withheld-cross-device",
    });
  });

  // Gateways released before tokenDelivery answer without it; a present token is then
  // the only signal, so the outcome must still resolve rather than read as withheld.
  it("classifies a rotate response from a Gateway that omits tokenDelivery", async () => {
    storeIdentity();
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({ token: "legacy-token", ...rotationResult }));

    const operation = rotateDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);

    expect(await operation).toEqual({ delivery: "in-band", token: "legacy-token" });
  });

  // The other legacy omission state: no field and no token is the withheld rotation that
  // used to end with nothing on screen, so it must resolve rather than read as an error.
  it("classifies a tokenless response from a Gateway that omits tokenDelivery", async () => {
    const state = createState(async () => ({ ...rotationResult }));

    expect(await rotateDeviceToken(state, tokenParams)).toEqual({
      delivery: "withheld-cross-device",
    });
  });

  // Explicit delivery and secret presence have to agree. A contradictory or unrecognized
  // pair leaves the outcome unknown, and either dialog would assert something the response
  // does not support, so it takes the error path with the previous token already dead.
  it.each([
    ["an in-band result that carries no token", { tokenDelivery: "in-band" }],
    [
      "a withheld result that carries a token",
      { tokenDelivery: "withheld-cross-device", token: "unexpected-token" },
    ],
    [
      "a delivery mode this client predates",
      { tokenDelivery: "out-of-band", token: "rotated-token" },
    ],
    // `token` is a non-empty string in the result schema, so a blank one is a malformed
    // envelope, not the withheld state - accepting it would report the reassuring outcome.
    [
      "a withheld result carrying a blank token",
      { tokenDelivery: "withheld-cross-device", token: "" },
    ],
    ["a blank token with no delivery field", { token: "" }],
  ])("refuses %s", async (_label, response) => {
    const state = createState(async () => ({ ...rotationResult, ...response }));

    expect(await rotateDeviceToken(state, tokenParams)).toBeNull();
    expect(state.devicesError).toContain("unusable result");
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  // Envelopes that identify no grant, drop a required field, or answer for a different grant
  // are not legacy responses: only `tokenDelivery` predates this client. Reporting any of them
  // would turn a broken or unrelated reply into a completion dialog for a credential the
  // operator may still hold, after the previous one was already invalidated.
  it.each([
    ["a null payload", null],
    ["a scalar payload", "rotated"],
    ["an empty object", {}],
    ["an array payload", []],
    ["a payload naming no role", { deviceId: "00" }],
    ["a payload omitting scopes", { deviceId: "00", role: "operator", rotatedAtMs: 1 }],
    ["a payload omitting rotatedAtMs", { deviceId: "00", role: "operator", scopes: [] }],
    [
      "a payload whose rotatedAtMs is not a whole timestamp",
      { ...rotationResult, rotatedAtMs: 1.5 },
    ],
    ["a payload carrying a blank scope", { ...rotationResult, scopes: [""] }],
    ["a payload naming a different device", { ...rotationResult, deviceId: "01" }],
    ["a payload naming a different role", { ...rotationResult, role: "viewer" }],
  ])("refuses %s", async (_label, response) => {
    const state = createState(async () => response);

    expect(await rotateDeviceToken(state, tokenParams)).toBeNull();
    expect(state.devicesError).toContain("unusable result");
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("does not clear a current token when a revoke request retires during identity loading", async () => {
    storeIdentity();
    storeDeviceAuthToken({ ...tokenParams, token: "current-token", scopes: ["operator.read"] });
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({}));

    const operation = revokeDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await operation;

    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("current-token");
  });

  it("normalizes malformed persisted scopes without breaking token loading", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "current-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens.operator.scopes = "not-an-array";
    localStorage.setItem(key, JSON.stringify(store));

    expect(loadDeviceAuthToken(tokenParams)).toMatchObject({
      token: "current-token",
      scopes: [],
    });
  });

  it("canonicalizes persisted role aliases before storing another token", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "operator-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens = { " operator ": store.tokens.operator };
    localStorage.setItem(key, JSON.stringify(store));

    storeDeviceAuthToken({
      ...tokenParams,
      role: "node",
      token: "node-token",
      scopes: ["node.invoke"],
    });

    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("operator-token");
  });

  it("removes persisted role aliases when clearing a token", () => {
    storeDeviceAuthToken({ ...tokenParams, token: "operator-token", scopes: [] });
    const key = storedTokenKey();
    const store = JSON.parse(localStorage.getItem(key) ?? "null");
    store.tokens[" operator "] = store.tokens.operator;
    localStorage.setItem(key, JSON.stringify(store));

    clearDeviceAuthToken(tokenParams);

    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });
});
