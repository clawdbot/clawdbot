import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadBackground,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
  sendRuntimeMessage,
} from "./background.test-harness.js";

function nativeSuccess(request: unknown, secret = TEST_RELAY_KEY) {
  const nonce = (request as { nonce?: unknown }).nonce;
  return {
    v: 1,
    ok: true,
    nonce,
    pairingString: `ws://127.0.0.1:18797/extension?gateway=ws%3A%2F%2F127.0.0.1%3A18789#${secret}`,
  };
}

describe("native extension bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an existing manual pairing without contacting the native host", async () => {
    const harness = await loadBackground();

    expect(harness.sendNativeMessage).not.toHaveBeenCalled();
    expect(harness.relaySockets).toHaveLength(1);
  });

  it("records host-not-found as retryable without claiming same-process recovery", async () => {
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async () => {
        throw new Error("Specified native messaging host not found.");
      },
    });
    await vi.waitFor(() => {
      expect(harness.storageValues).toMatchObject({
        nativeBootstrapState: "retrying",
        nativeBootstrapFailureCode: "host_not_found",
      });
    });

    harness.alarmListener({ name: "openclaw-relay-watchdog" });

    await vi.waitFor(() => expect(harness.sendNativeMessage).toHaveBeenCalledTimes(2));
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });

  it("coalesces startup, watchdog, and popup attempts", async () => {
    let resolveNative = (_value: unknown) => {};
    const pending = new Promise((resolve) => {
      resolveNative = resolve;
    });
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (request) => {
        const response = await pending;
        return response ?? nativeSuccess(request);
      },
    });
    harness.alarmListener({ name: "openclaw-relay-watchdog" });
    const status = sendRuntimeMessage(harness, { type: "getStatus" });

    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
    const request = harness.sendNativeMessage.mock.calls[0]?.[1];
    resolveNative(nativeSuccess(request));
    await status;
    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
  });

  it("does not overwrite a manual pairing that wins a native response race", async () => {
    let resolveNative = (_value: unknown) => {};
    let request: unknown;
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (value) => {
        request = value;
        return await new Promise((resolve) => {
          resolveNative = resolve;
        });
      },
    });

    await expect(
      sendRuntimeMessage(harness, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
        accessMode: "selected",
      }),
    ).resolves.toEqual({ ok: true });
    resolveNative(nativeSuccess(request));

    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18798/extension",
      token: REPLACEMENT_TEST_RELAY_KEY,
      accessMode: "selected",
    });
  });

  it("unpair disables bootstrap before a late native response can re-pair", async () => {
    let resolveNative = (_value: unknown) => {};
    let request: unknown;
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async (value) => {
        request = value;
        return await new Promise((resolve) => {
          resolveNative = resolve;
        });
      },
    });

    await expect(sendRuntimeMessage(harness, { type: "unpair" })).resolves.toEqual({ ok: true });
    expect(harness.storageValues.nativeBootstrapDisabled).toBe(true);
    resolveNative(nativeSuccess(request));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.storageValues).not.toHaveProperty("relayUrl");
    expect(harness.relaySockets).toHaveLength(0);
  });

  it("preserves opt-out across restart and manual pairing clears it", async () => {
    const harness = await loadBackground({
      storedConfig: { nativeBootstrapDisabled: true, nativeBootstrapState: "disabled" },
    });
    expect(harness.sendNativeMessage).not.toHaveBeenCalled();

    await expect(
      sendRuntimeMessage(harness, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.storageValues).not.toHaveProperty("nativeBootstrapDisabled");
  });

  it("fails closed on a malformed or nonce-mismatched response", async () => {
    const harness = await loadBackground({
      storedConfig: {},
      nativeMessage: async () => ({
        v: 1,
        ok: true,
        nonce: "wrong",
        pairingString: `ws://127.0.0.1:18797/extension#${TEST_RELAY_KEY}`,
      }),
    });
    await vi.waitFor(() => {
      expect(harness.storageValues).toMatchObject({
        nativeBootstrapState: "manual_required",
        nativeBootstrapFailureCode: "malformed_response",
      });
    });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });
});

describe("relay pairing and authentication", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears malformed persisted pairing before opening a relay", async () => {
    const harness = await loadBackground({
      storedConfig: { relayUrl: "ws://gateway.example/extension", token: TEST_RELAY_KEY },
    });

    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });

  it("offers only the non-secret v2 relay subprotocol", async () => {
    const harness = await loadBackground();
    expect(harness.relaySockets[0]?.protocols).toEqual(["openclaw-extension-relay.v2"]);
    expect(JSON.stringify(harness.relaySockets[0]?.protocols)).not.toContain(TEST_RELAY_KEY);
  });

  it("revokes synchronously while an older manual pair is stalled", async () => {
    const harness = await loadBackground({
      initialTabs: [{ id: 131, url: "https://example.com/paired", groupId: 7 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.storageSet.mockClear();
    const releaseSave = harness.deferNextStorageSet();
    const pairing = sendRuntimeMessage(harness, {
      type: "pair",
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      accessMode: "all",
    });
    await vi.waitFor(() =>
      expect(harness.storageSet).toHaveBeenCalledWith(
        expect.objectContaining({ relayUrl: "ws://127.0.0.1:18798/extension" }),
      ),
    );

    const unpairing = sendRuntimeMessage(harness, { type: "unpair" });
    expect(socket.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(harness.storageValues.nativeBootstrapDisabled).toBe(true));
    releaseSave();

    await expect(pairing).resolves.toMatchObject({ ok: false });
    await expect(unpairing).resolves.toEqual({ ok: true });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
  });
});
