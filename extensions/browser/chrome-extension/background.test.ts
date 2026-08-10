import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadBackground,
  RELAY_SECRET,
  REPLACEMENT_RELAY_SECRET,
  sendRuntimeMessage,
} from "./background.test-harness.js";
import { AUTH_INSTANCE_ID, AUTH_SERVER_NONCE, AUTH_SESSION_ID } from "./background.test-support.js";

const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const START_TIME_MS = Date.parse("2026-07-16T08:00:00.000Z");

describe("persisted relay pairing validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the canonical persisted pairing on startup", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        authVersion: 2,
        gatewayUrl: "wss://gateway.example.com",
        groupColor: "blue",
      },
    });

    await vi.waitFor(() => {
      expect(harness.relaySockets).toHaveLength(1);
      expect(harness.gatewaySockets).toHaveLength(1);
    });
    expect(harness.relaySockets[0]).toMatchObject({
      url: "wss://gateway.example.com/browser/extension",
      protocols: ["openclaw-extension-relay.v2"],
    });
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });

  it("migrates a canonical existing pairing to authVersion 2 before connecting", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "",
        groupColor: "orange",
      },
    });
    await vi.waitFor(() => expect(harness.relaySockets).toHaveLength(1));
    expect(harness.storageSet).toHaveBeenCalledWith({ authVersion: 2, accessMode: "selected" });
    expect(harness.storageValues.authVersion).toBe(2);
  });

  it.each([
    ["an invalid token", { relayUrl: "ws://127.0.0.1:18797/extension", token: "short" }],
    [
      "an unsafe remote relay URL",
      { relayUrl: "ws://gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "URL credentials",
      { relayUrl: "wss://user:pass@gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "an unsafe remote Gateway URL",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "ws://gateway.example.com",
      },
    ],
    [
      "Gateway URL credentials",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://user:pass@gateway.example.com",
      },
    ],
    [
      "a Gateway URL query",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com?token=nope",
      },
    ],
    [
      "a Gateway URL fragment",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com#fragment",
      },
    ],
    ["a malformed URL", { relayUrl: "not a URL", token: RELAY_SECRET }],
    [
      "an unknown query",
      { relayUrl: "ws://127.0.0.1:18797/extension?unknown=1", token: RELAY_SECRET },
    ],
    ["partial state", { relayUrl: "ws://127.0.0.1:18797/extension", groupColor: "orange" }],
    [
      "a proxy-prefixed direct pairing",
      { relayUrl: "wss://gateway.example.com/proxy/browser/extension", token: RELAY_SECRET },
    ],
    [
      "mismatched direct state",
      {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://other.example.com",
      },
    ],
  ])("clears %s before startup can open a socket", async (_label, storedConfig) => {
    const harness = await loadBackground({ storedConfig });

    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.gatewaySockets).toHaveLength(0);
    expect(harness.storageRemove).toHaveBeenCalledWith([
      "relayUrl",
      "gatewayUrl",
      "token",
      "authVersion",
    ]);
    const response = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, response);
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({
          paired: false,
          state: "off",
          accessMode: "selected",
          accessibleTabCount: 0,
          relayUrl: "",
        }),
      );
    });
  });

  it("stays unpaired when clearing invalid persisted state fails", async () => {
    const harness = await loadBackground({
      rejectStorageRemove: true,
      storedConfig: { relayUrl: "ws://gateway.example.com/extension", token: RELAY_SECRET },
    });

    const response = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, response);

    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({
        paired: false,
        state: "off",
        accessMode: "selected",
        accessibleTabCount: 0,
        relayUrl: "",
      });
    });
    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.gatewaySockets).toHaveLength(0);
    expect(harness.storageRemove).toHaveBeenCalled();
    expect(harness.storageValues).toMatchObject({ token: RELAY_SECRET });
  });

  it("revalidates persisted state before a reconnect", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected initial relay socket");
    }
    harness.storageValues.token = "invalid-after-startup";

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.sockets).toHaveLength(1);
    expect(harness.storageRemove).toHaveBeenCalledWith([
      "relayUrl",
      "gatewayUrl",
      "token",
      "authVersion",
    ]);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("disconnects both live consumers when the watchdog observes invalid state", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com",
      },
    });
    await vi.waitFor(() => {
      expect(harness.relaySockets).toHaveLength(1);
      expect(harness.gatewaySockets).toHaveLength(1);
    });
    harness.storageValues.token = "invalid-after-startup";

    harness.alarmListener({ name: RELAY_WATCHDOG_ALARM });

    await vi.waitFor(() => {
      expect(harness.relaySockets[0]?.close).toHaveBeenCalled();
      expect(harness.gatewaySockets[0]?.close).toHaveBeenCalled();
      expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    });
    expect(harness.sockets).toHaveLength(2);
  });

  it("does not let stale invalid cleanup erase a concurrently saved pairing", async () => {
    const harness = await loadBackground();
    harness.storageValues.token = "invalid-after-startup";
    const releaseRemove = harness.deferNextStorageRemove();
    const statusResponse = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, statusResponse);
    await vi.waitFor(() => expect(harness.storageRemove).toHaveBeenCalled());
    const pairResponse = vi.fn();
    harness.messageListener(
      {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      },
      {},
      pairResponse,
    );

    releaseRemove();

    await vi.waitFor(() => expect(pairResponse).toHaveBeenCalledWith({ ok: true }));
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18798/extension",
      token: REPLACEMENT_RELAY_SECRET,
      gatewayUrl: "",
    });
    const replacement = harness.relaySockets.find(
      (socket) => socket.url === "ws://127.0.0.1:18798/extension",
    );
    expect(replacement).toBeDefined();
    expect(replacement?.close).not.toHaveBeenCalled();
  });

  it("unpair detaches every debugger session and clears session denies", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        authVersion: 2,
        accessMode: "all",
      },
      sessionConfig: { deniedTabIdsV1: [122] },
      initialTabs: [
        { id: 121, url: "https://example.com/attached", groupId: -1 },
        { id: 122, url: "https://example.com/paused", groupId: -1 },
      ],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 35, tabId: 121 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());

    await expect(sendRuntimeMessage(harness, { type: "unpair" })).resolves.toEqual({ ok: true });

    expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 121 });
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    expect(harness.storageValues).not.toHaveProperty("accessMode");
  });

  it("revokes immediately and supersedes an older pair stalled in storage", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 131, url: "https://example.com/paired", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerEventListener) {
      throw new Error("expected relay and debugger event listener");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 36, tabId: 131 });
    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "result",
        seq: 36,
        result: { targetId: "tab-131" },
      });
    });

    harness.storageSet.mockClear();
    const releasePairSave = harness.deferNextStorageSet();
    const pairing = sendRuntimeMessage(harness, {
      type: "pair",
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      accessMode: "all",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith(
        expect.objectContaining({
          relayUrl: "ws://127.0.0.1:18798/extension",
          token: REPLACEMENT_RELAY_SECRET,
        }),
      );
    });

    const unpairing = sendRuntimeMessage(harness, { type: "unpair" });
    expect(socket.close).toHaveBeenCalledOnce();
    await expect(
      sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 131 }),
    ).resolves.toEqual({
      accessMode: "all",
      accessible: false,
      eligible: false,
      denied: false,
    });
    harness.debuggerEventListener({ tabId: 131 }, "Runtime.consoleAPICalled", { value: 1 });
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent" && frame.method === "Runtime.consoleAPICalled"),
    ).toBe(false);

    releasePairSave();
    await expect(pairing).resolves.toEqual({
      ok: false,
      error: "Pairing was superseded by a newer request.",
    });
    await expect(unpairing).resolves.toEqual({ ok: true });

    expect(harness.relaySockets).toHaveLength(1);
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 131 });
    expect(harness.storageValues).not.toHaveProperty("relayUrl");
    expect(harness.storageValues).not.toHaveProperty("token");
    expect(harness.storageValues).not.toHaveProperty("accessMode");
  });

  it("lets the newest pair supersede an older pair stalled in storage", async () => {
    const harness = await loadBackground();
    const original = harness.relaySockets[0];
    if (!original) {
      throw new Error("expected original relay socket");
    }
    await harness.authenticate(original);

    harness.storageSet.mockClear();
    const releaseFirstSave = harness.deferNextStorageSet();
    const firstPair = sendRuntimeMessage(harness, {
      type: "pair",
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      accessMode: "all",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith(
        expect.objectContaining({ relayUrl: "ws://127.0.0.1:18798/extension" }),
      );
    });

    const newestSecret = "c".repeat(64);
    const secondPair = sendRuntimeMessage(harness, {
      type: "pair",
      pairingString: `ws://127.0.0.1:18799/extension#${newestSecret}`,
      accessMode: "selected",
    });
    releaseFirstSave();

    await expect(firstPair).resolves.toEqual({
      ok: false,
      error: "Pairing was superseded by a newer request.",
    });
    await expect(secondPair).resolves.toEqual({ ok: true });
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18799/extension",
      token: newestSecret,
      accessMode: "selected",
    });
    expect(
      harness.relaySockets.some((socket) => socket.url === "ws://127.0.0.1:18798/extension"),
    ).toBe(false);
    expect(
      harness.relaySockets.filter((socket) => socket.url === "ws://127.0.0.1:18799/extension"),
    ).toHaveLength(1);
  });
});

describe("relay authentication v2 transport", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers only the non-secret v2 protocol", async () => {
    const harness = await loadBackground();
    const socket = harness.relaySockets[0];
    expect(socket?.protocols).toEqual(["openclaw-extension-relay.v2"]);
    expect(JSON.stringify(socket?.protocols)).not.toContain(RELAY_SECRET);
  });

  it("rejects a mismatched negotiated protocol before sending any frame", async () => {
    const harness = await loadBackground({ relayNegotiatedProtocol: "" });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("sends no client proof or application hello after a bad server proof", async () => {
    const harness = await loadBackground();
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    const helloRaw = socket.send.mock.calls[0]?.[0];
    const hello = JSON.parse(helloRaw) as { keyId: string; clientNonce: string };
    const issuedAtMs = Date.now();
    socket.receive({
      type: "auth.challenge",
      v: 2,
      keyId: hello.keyId,
      instanceId: AUTH_INSTANCE_ID,
      sessionId: AUTH_SESSION_ID,
      clientNonce: hello.clientNonce,
      serverNonce: AUTH_SERVER_NONCE,
      issuedAtMs,
      expiresAtMs: issuedAtMs + 10_000,
      role: "extension",
      transport: "websocket",
      method: "GET",
      resource: "/extension",
      flow: "extension",
      serverProof: "A".repeat(43),
    });
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    const types = socket.send.mock.calls.map(([raw]) => JSON.parse(raw).type);
    expect(types).toEqual(["auth.hello"]);
    expect(harness.setBadgeText).not.toHaveBeenLastCalledWith({ text: "ON" });
  });

  it("rejects application commands before authentication", async () => {
    const harness = await loadBackground();
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    socket.receive({ type: "attach", seq: 1, tabId: 1 });
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalled());
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
  });
});

async function startPendingPageShare(
  harness: Awaited<ReturnType<typeof loadBackground>>,
  socket = harness.sockets.at(-1),
) {
  if (!socket) {
    throw new Error("expected the page-share relay socket");
  }
  if (socket.readyState !== 1) {
    await harness.authenticate(socket);
  }
  harness.executeScript.mockResolvedValueOnce([
    {
      result: {
        url: "https://example.com/article",
        title: "Example article",
        selection: "",
        content: "Article body",
      },
    },
  ]);
  const response = vi.fn();
  expect(harness.messageListener({ type: "sendPageToOpenClaw", tabId: 1 }, {}, response)).toBe(
    true,
  );
  await vi.waitFor(() => {
    expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "pageShare")).toBe(true);
  });
  const raw = socket.send.mock.calls.find(([frame]) => JSON.parse(frame).type === "pageShare")?.[0];
  if (typeof raw !== "string") {
    throw new Error("expected a sent page-share request");
  }
  return { socket, response, requestId: (JSON.parse(raw) as { requestId: number }).requestId };
}

describe("relay opening deadline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a stuck connecting socket and retries", async () => {
    const harness = await loadBackground();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.createAlarm).toHaveBeenCalledWith(RELAY_WATCHDOG_ALARM, {
      periodInMinutes: 0.5,
    });
    const openingDeadline = harness.createAlarm.mock.calls.find(
      ([name]) => name === RELAY_OPENING_DEADLINE_ALARM,
    )?.[1]?.when;
    if (typeof openingDeadline !== "number") {
      throw new Error("expected relay opening deadline alarm");
    }
    expect(openingDeadline).toBe(Date.now() + 10_000);

    vi.setSystemTime(openingDeadline);
    harness.alarmListener({ name: RELAY_OPENING_DEADLINE_ALARM });

    expect(harness.sockets[0]?.close).toHaveBeenCalledOnce();
    expect(harness.clearAlarm).toHaveBeenCalledWith(RELAY_OPENING_DEADLINE_ALARM);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.createAlarm).toHaveBeenLastCalledWith(RELAY_OPENING_DEADLINE_ALARM, {
      when: openingDeadline + 11_000,
    });
  });

  it("clears the deadline only after relay authentication completes", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    expect(socket).toBeDefined();

    const clearsBeforeOpen = harness.clearAlarm.mock.calls.length;
    socket?.open();
    expect(harness.clearAlarm).toHaveBeenCalledTimes(clearsBeforeOpen);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "…" });

    if (socket) {
      await harness.authenticate(socket);
    }
    expect(harness.clearAlarm).toHaveBeenCalledWith(RELAY_OPENING_DEADLINE_ALARM);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });

    vi.setSystemTime(START_TIME_MS + 60_000);
    harness.alarmListener({ name: RELAY_OPENING_DEADLINE_ALARM });
    expect(socket?.close).not.toHaveBeenCalled();
  });
});

describe("copilot panel messaging", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("responds exactly once when the tab cannot be retrieved", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 44."));
    const sendResponse = vi.fn();

    expect(
      harness.messageListener({ type: "prepareCopilotPanel", tabId: 44 }, {}, sendResponse),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "No tab with id: 44.",
    });
  });

  it("responds exactly once with the prepared panel path", async () => {
    const harness = await loadBackground();
    const sendResponse = vi.fn();

    expect(
      harness.messageListener({ type: "prepareCopilotPanel", tabId: 44 }, {}, sendResponse),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      path: expect.stringMatching(/^sidepanel\.html\?binding=/),
    });
  });
});

describe("popup message failure responses", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("responds exactly once when a selected tab closes before it can be grouped", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 44."));
    const sendResponse = vi.fn();

    expect(
      harness.messageListener(
        { type: "toggleTabAccess", tabId: 44, accessMode: "selected", grant: true },
        {},
        sendResponse,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        error: "No tab with id: 44.",
      });
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
  });

  it.each([
    { action: "share", initiallyShared: false },
    { action: "unshare", initiallyShared: true },
  ])(
    "responds exactly once when $action consent reconciliation rejects",
    async ({ initiallyShared }) => {
      const error = "Could not reconcile browser tab consent.";
      const onConsentChanged = vi.fn(async () => {
        throw new Error(error);
      });
      const harness = await loadBackground({ onConsentChanged });
      if (initiallyShared) {
        harness.shareTab(44);
      }
      const sendResponse = vi.fn();

      expect(
        harness.messageListener(
          {
            type: "toggleTabAccess",
            tabId: 44,
            accessMode: "selected",
            grant: !initiallyShared,
          },
          {},
          sendResponse,
        ),
      ).toBe(true);

      await vi.waitFor(() => {
        expect(onConsentChanged).toHaveBeenCalledOnce();
      });
      if (initiallyShared) {
        expect(harness.tabsUngroup).toHaveBeenCalledWith([44]);
      } else {
        expect(harness.tabsGroup).toHaveBeenCalledWith({ tabIds: [44] });
      }
      expect(sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
      expect(sendResponse).not.toHaveBeenCalledWith({
        ok: true,
        accessible: !initiallyShared,
        denied: false,
      });
    },
  );

  it.each([
    {
      message: {
        type: "pair" as const,
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      },
      operation: "set" as const,
      error: "Could not save browser pairing.",
    },
    {
      message: { type: "unpair" as const },
      operation: "remove" as const,
      error: "Could not remove browser pairing.",
    },
  ])(
    "responds exactly once when $message.type storage rejects",
    async ({ message, operation, error }) => {
      const harness = await loadBackground();
      const storageOperation = operation === "set" ? harness.storageSet : harness.storageRemove;
      storageOperation.mockRejectedValueOnce(new Error(error));
      const sendResponse = vi.fn();

      expect(harness.messageListener(message, {}, sendResponse)).toBe(true);

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
      });
    },
  );
});

describe("page-share relay request lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("immediately rejects a page share when its owning relay disconnects", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.close();

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("immediately rejects a page share when the user unpairs the relay", async () => {
    const harness = await loadBackground({ deferSocketClose: true });
    const pending = await startPendingPageShare(harness);
    const unpairResponse = vi.fn();

    expect(harness.messageListener({ type: "unpair" }, {}, unpairResponse)).toBe(true);

    await vi.waitFor(() => {
      expect(unpairResponse).toHaveBeenCalledWith({ ok: true });
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.socket.close).toHaveBeenCalledOnce();
    expect(pending.socket.readyState).toBe(2);
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("rejects old page shares before a replacement relay finishes closing", async () => {
    const harness = await loadBackground({ deferSocketClose: true });
    const pending = await startPendingPageShare(harness);
    const pairResponse = vi.fn();

    expect(
      harness.messageListener(
        {
          type: "pair",
          pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
        },
        {},
        pairResponse,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(pairResponse).toHaveBeenCalledWith({ ok: true });
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.socket.close).toHaveBeenCalledOnce();
    expect(pending.socket.readyState).toBe(2);
    expect(harness.sockets).toHaveLength(2);
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("preserves the acknowledgement from the page share's own relay", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.receive({ type: "pageShareResult", requestId: pending.requestId, ok: true });

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({ ok: true });
    });
    pending.socket.close();
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("preserves the delivery error returned by the page share's own relay", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.receive({
      type: "pageShareResult",
      requestId: pending.requestId,
      ok: false,
      error: "Gateway page-share queue unavailable.",
    });

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Gateway page-share queue unavailable.",
      });
    });
    pending.socket.close();
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("does not let a stale socket reject a share on the reconnected relay", async () => {
    const harness = await loadBackground();
    const original = await startPendingPageShare(harness);

    original.socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    const replacement = await startPendingPageShare(harness);

    original.socket.receive({
      type: "pageShareResult",
      requestId: replacement.requestId,
      ok: false,
      error: "Stale relay response.",
    });
    original.socket.close();
    expect(replacement.response).not.toHaveBeenCalled();

    replacement.socket.receive({
      type: "pageShareResult",
      requestId: replacement.requestId,
      ok: true,
    });

    await vi.waitFor(() => {
      expect(original.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
      expect(replacement.response).toHaveBeenCalledWith({ ok: true });
    });
    expect(original.response).toHaveBeenCalledOnce();
    expect(replacement.response).toHaveBeenCalledOnce();
  });
});
