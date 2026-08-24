import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
  sendRuntimeMessage,
} from "./background.test-harness.js";
import type { RetiredStorageFailureStage } from "./background.test-harness.js";

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

  afterEach(async () => {
    await cleanupBackgroundHarnesses();
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

  it("blocks every startup path while retired copilot custody is unresolved", async () => {
    const harness = await loadBackground({
      deferRetiredStatePreparation: true,
      inheritedDebuggerTabIds: [17],
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
        copilotSessionRegistryV1: {
          sessions: { 17: { creationPending: true } },
          pendingArchives: [],
        },
      },
    });

    harness.alarmListener({ name: "openclaw-relay-watchdog" });
    harness.startupListener();
    harness.installedListener();
    await Promise.resolve();
    expect(harness.sendNativeMessage).not.toHaveBeenCalled();
    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.debuggerAttach).not.toHaveBeenCalled();

    harness.releaseRetiredStatePreparation();
    await vi.waitFor(() => expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 17 }));
    expect(harness.sendNativeMessage).not.toHaveBeenCalled();
    expect(harness.relaySockets).toHaveLength(0);

    const status = await sendRuntimeMessage(harness, { type: "getStatus" });
    expect(status).toMatchObject({
      paired: true,
      retiredCopilotCustodyBlocked: true,
      accessibleTabCount: 0,
    });
    expect(JSON.stringify(status)).not.toMatch(/creationPending|pendingArchives|sessionKey/u);
    await expect(
      sendRuntimeMessage(harness, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      sendRuntimeMessage(harness, { type: "setNativeBootstrapEnabled", enabled: true }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      sendRuntimeMessage(harness, { type: "setAccessMode", accessMode: "selected" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 17,
        accessMode: "all",
        grant: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18797/extension",
      accessMode: "all",
      copilotSessionRegistryV1: expect.any(Object),
    });
  });

  it("uses explicit Disconnect to discard custody before local setup can reconnect", async () => {
    const harness = await loadBackground({
      nativeMessage: async (request) => nativeSuccess(request),
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
        copilotSessionRegistryV1: {
          sessions: { 17: { creationPending: true } },
          pendingArchives: [],
        },
        copilotDeviceIdentitiesV1: { redacted: true },
        copilotDeviceTokensV1: { redacted: true },
      },
      sessionConfig: {
        copilotBrowserInstanceV1: "redacted",
        copilotPanelBindingsV1: { 17: "redacted" },
      },
    });

    await expect(sendRuntimeMessage(harness, { type: "unpair" })).resolves.toEqual({ ok: true });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
    expect(harness.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
    expect(harness.sessionStorageValues).not.toHaveProperty("copilotBrowserInstanceV1");
    expect(harness.storageValues.nativeBootstrapDisabled).toBe(true);

    await expect(
      sendRuntimeMessage(harness, { type: "setNativeBootstrapEnabled", enabled: true }),
    ).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    expect(harness.sendNativeMessage).toHaveBeenCalledOnce();
  });

  it.each<RetiredStorageFailureStage>([
    "marker_set",
    "session_remove",
    "retired_local_remove",
    "marker_remove",
  ])(
    "keeps custody blocked when Disconnect fails at %s and permits an explicit retry",
    async (stage) => {
      const harness = await loadBackground({
        inheritedDebuggerTabIds: [17],
        retiredStorageFailureStage: stage,
        storedConfig: {
          relayUrl: "ws://127.0.0.1:18797/extension",
          token: TEST_RELAY_KEY,
          authVersion: 2,
          accessMode: "all",
          copilotSessionRegistryV1: {
            sessions: { 17: { creationPending: true } },
            pendingArchives: [],
          },
        },
        sessionConfig: {
          copilotBrowserInstanceV1: "redacted",
          copilotPanelBindingsV1: { 17: "redacted" },
        },
      });

      await expect(sendRuntimeMessage(harness, { type: "unpair" })).resolves.toMatchObject({
        ok: false,
      });
      await expect(sendRuntimeMessage(harness, { type: "getStatus" })).resolves.toMatchObject({
        retiredCopilotCustodyBlocked: true,
      });
      expect(harness.relaySockets).toHaveLength(0);
      expect(harness.sendNativeMessage).not.toHaveBeenCalled();
      expect(harness.debuggerAttach).not.toHaveBeenCalled();
      if (stage === "marker_set") {
        expect(harness.storageValues).toHaveProperty("copilotSessionRegistryV1");
        expect(harness.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      } else {
        expect(harness.storageValues.retiredCopilotCustodyBlockedV1).toBe(true);
      }
      if (stage === "session_remove" || stage === "retired_local_remove") {
        expect(harness.storageValues).toHaveProperty("copilotSessionRegistryV1");
      }
      if (stage === "marker_remove") {
        expect(harness.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
      }

      harness.setRetiredStorageFailureStage(undefined);
      await expect(sendRuntimeMessage(harness, { type: "unpair" })).resolves.toEqual({ ok: true });
      expect(harness.storageValues).not.toHaveProperty("retiredCopilotCustodyBlockedV1");
      expect(harness.storageValues).not.toHaveProperty("copilotSessionRegistryV1");
      expect(harness.sessionStorageValues).not.toHaveProperty("copilotBrowserInstanceV1");
      expect(harness.storageValues.nativeBootstrapDisabled).toBe(true);
      expect(harness.relaySockets).toHaveLength(0);
    },
  );

  it("keeps a persisted custody marker inert across worker startup without a registry", async () => {
    const harness = await loadBackground({
      inheritedDebuggerTabIds: [18],
      nativeMessage: async (request) => nativeSuccess(request),
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
        retiredCopilotCustodyBlockedV1: true,
      },
    });

    await vi.waitFor(() => expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 18 }));
    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.sendNativeMessage).not.toHaveBeenCalled();
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
    await expect(sendRuntimeMessage(harness, { type: "getStatus" })).resolves.toMatchObject({
      retiredCopilotCustodyBlocked: true,
      accessibleTabCount: 0,
    });
  });
});

describe("relay pairing and authentication", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    await cleanupBackgroundHarnesses();
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

  it("cancels the opening deadline when the socket-close fallback ends the relay", async () => {
    const harness = await loadBackground({ relayNegotiatedProtocol: "unsupported" });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    harness.clearAlarm.mockClear();
    socket.close.mockImplementationOnce(() => {
      throw new Error("socket close failed");
    });

    socket.open();

    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(2));
    expect(harness.clearAlarm).toHaveBeenCalledOnce();
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
