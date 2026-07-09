/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
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
    devicesError: null,
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

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device token request lifecycle", () => {
  it("does not reveal or persist a rotate response from a retired request epoch", async () => {
    const response = deferred<unknown>();
    const state = createState(() => response.promise);
    const prompt = vi.spyOn(window, "prompt").mockImplementation(() => null);

    const operation = rotateDeviceToken(state, tokenParams);
    state.requestGeneration += 1;
    response.resolve({ token: "stale-token", ...tokenParams });
    await operation;

    expect(prompt).not.toHaveBeenCalled();
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("rechecks rotate ownership after loading the local identity", async () => {
    storeIdentity();
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({ token: "stale-token", ...tokenParams }));
    const prompt = vi.spyOn(window, "prompt").mockImplementation(() => null);

    const operation = rotateDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await operation;

    expect(prompt).not.toHaveBeenCalled();
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("does not clear a current token when a revoke request retires during identity loading", async () => {
    storeIdentity();
    storeDeviceAuthToken({ ...tokenParams, token: "current-token", scopes: ["operator.read"] });
    const { digest, digestMock } = deferIdentityFingerprint();
    const state = createState(async () => ({}));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const operation = revokeDeviceToken(state, tokenParams);
    await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
    state.requestGeneration += 1;
    digest.resolve(new Uint8Array([0]).buffer);
    await operation;

    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("current-token");
  });
});
