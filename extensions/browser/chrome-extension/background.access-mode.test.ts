import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  TEST_RELAY_KEY,
  REPLACEMENT_TEST_RELAY_KEY,
  sendRuntimeMessage,
} from "./background.test-harness.js";

const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";

describe("relay command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    await cleanupBackgroundHarnesses();
    vi.unstubAllGlobals();
  });

  it("rejects every authority-bearing command after tab-group revocation", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.shareTab(41);
    harness.unshareTab(41);

    socket.receive({ type: "attach", seq: 1, tabId: 41 });
    socket.receive({ type: "cdp", seq: 2, tabId: 41, method: "Runtime.evaluate" });
    socket.receive({ type: "closeTab", seq: 3, tabId: 41 });
    socket.receive({ type: "activateTab", seq: 4, tabId: 41 });

    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(
        frames
          .filter((frame) => frame.type === "error")
          .map((frame) => frame.seq)
          .toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4]);
    });
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
    expect(harness.debuggerSendCommand).not.toHaveBeenCalled();
    expect(harness.tabsRemove).not.toHaveBeenCalled();
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.windowsUpdate).not.toHaveBeenCalled();
  });

  it("controls an eligible ungrouped tab in all mode", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 41, url: "https://example.com/all", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    const hello = socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((frame) => frame.type === "hello");
    expect(hello.tabs).toContainEqual(
      expect.objectContaining({ tabId: 41, url: "https://example.com/all" }),
    );

    socket.receive({ type: "attach", seq: 20, tabId: 41 });
    socket.receive({ type: "cdp", seq: 21, tabId: 41, method: "Runtime.evaluate" });

    await vi.waitFor(() => {
      expect(harness.debuggerAttach).toHaveBeenCalledWith({ tabId: 41 }, "1.3");
      expect(harness.debuggerSendCommand).toHaveBeenCalledWith(
        { tabId: 41 },
        "Runtime.evaluate",
        {},
      );
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({ type: "result", seq: 21, result: {} });
    });
  });

  it("closes the old selected relay before a replacement pairing widens access", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "selected",
      },
      initialTabs: [{ id: 45, url: "https://example.com/private", groupId: -1 }],
    });
    const oldSocket = harness.relaySockets[0];
    if (!oldSocket) {
      throw new Error("expected old relay socket");
    }
    await harness.authenticate(oldSocket);

    await expect(
      sendRuntimeMessage(harness, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
        accessMode: "all",
      }),
    ).resolves.toEqual({ ok: true });

    expect(oldSocket.close).toHaveBeenCalledOnce();
    const oldFrames = oldSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(
      oldFrames.some(
        (frame) =>
          frame.type === "tabs" && frame.tabs?.some((tab: { tabId?: number }) => tab.tabId === 45),
      ),
    ).toBe(false);

    const replacement = harness.relaySockets.find(
      (socket) => socket.url === "ws://127.0.0.1:18798/extension",
    );
    if (!replacement) {
      throw new Error("expected replacement relay socket");
    }
    await harness.authenticate(replacement);
    const replacementHello = replacement.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((frame) => frame.type === "hello");
    expect(replacementHello.tabs).toContainEqual(expect.objectContaining({ tabId: 45 }));
  });

  it("cancels a stale lifecycle connection across replacement pairing", async () => {
    const harness = await loadBackground();
    const oldSocket = harness.relaySockets[0];
    if (!oldSocket) {
      throw new Error("expected old relay socket");
    }
    await harness.authenticate(oldSocket);
    oldSocket.close();

    const releaseConfigRead = harness.deferNextStorageGet();
    harness.alarmListener({ name: RELAY_WATCHDOG_ALARM });
    const pairing = sendRuntimeMessage(harness, {
      type: "pair",
      pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
      accessMode: "all",
    });
    releaseConfigRead();

    await expect(pairing).resolves.toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(
        harness.relaySockets.filter((socket) => socket.url === "ws://127.0.0.1:18798/extension"),
      ).toHaveLength(1);
    });
    expect(
      harness.relaySockets.filter((socket) => socket.url === "ws://127.0.0.1:18797/extension"),
    ).toHaveLength(1);
  });

  it("waits for access initialization before changing the stored mode", async () => {
    const harness = await loadBackground({
      deferTabAccessInitialization: true,
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
    });
    harness.storageSet.mockClear();
    const response = vi.fn();

    harness.messageListener({ type: "setAccessMode", accessMode: "selected" }, {}, response);
    await Promise.resolve();
    await Promise.resolve();

    expect(response).not.toHaveBeenCalled();
    expect(harness.storageSet).not.toHaveBeenCalled();
    harness.releaseTabAccessInitialization();
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({ ok: true, accessMode: "selected" });
    });
  });

  it("waits for access initialization before toggling an all-mode tab", async () => {
    const harness = await loadBackground({
      deferTabAccessInitialization: true,
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 46, url: "https://example.com/pending-init", groupId: -1 }],
    });
    harness.tabsGet.mockClear();
    const response = vi.fn();

    harness.messageListener(
      { type: "toggleTabAccess", tabId: 46, accessMode: "all", grant: false },
      {},
      response,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(response).not.toHaveBeenCalled();
    expect(harness.tabsGet).not.toHaveBeenCalled();
    expect(harness.tabsGroup).not.toHaveBeenCalled();
    harness.releaseTabAccessInitialization();
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({ ok: true, accessible: false, denied: true });
    });
    expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([46]);
    expect(harness.tabsGroup).not.toHaveBeenCalled();
  });

  it.each([undefined, null, Number.NaN, -1, 1.5, "41"])(
    "rejects malformed getTabAccess tab id %s without querying Chrome",
    async (tabId) => {
      const harness = await loadBackground();
      harness.tabsGet.mockClear();

      await expect(sendRuntimeMessage(harness, { type: "getTabAccess", tabId })).resolves.toEqual({
        accessMode: "selected",
        accessible: false,
        eligible: false,
        denied: false,
      });
      expect(harness.tabsGet).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      accessMode: "all",
      label: "restricted",
      tab: { id: 51, url: "chrome://settings", groupId: 7 },
    },
    {
      accessMode: "selected",
      label: "restricted",
      tab: { id: 51, url: "chrome://settings", groupId: 7 },
    },
    {
      accessMode: "all",
      label: "incognito",
      tab: { id: 52, url: "https://secret.example", incognito: true, groupId: 7 },
    },
    {
      accessMode: "selected",
      label: "incognito",
      tab: { id: 52, url: "https://secret.example", incognito: true, groupId: 7 },
    },
  ])("rejects an $label tab in $accessMode mode", async ({ accessMode, tab }) => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode,
      },
      initialTabs: [tab],
    });
    harness.shareTab(tab.id);
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 22, tabId: tab.id });
    await vi.waitFor(() => {
      const frame = socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .find((candidate) => candidate.type === "error" && candidate.seq === 22);
      expect(frame?.message).toMatch(/restricted|incognito/);
    });
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight CDP command when all mode downgrades to selected", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 61, url: "https://example.com/race", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 23, tabId: 61 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
    let releaseCommand = () => {};
    harness.debuggerSendCommand.mockImplementationOnce(
      async () =>
        await new Promise<Record<string, never>>((resolve) => {
          releaseCommand = () => resolve({});
        }),
    );
    socket.receive({ type: "cdp", seq: 24, tabId: 61, method: "Runtime.evaluate" });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());

    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    releaseCommand();

    await expect(changingMode).resolves.toMatchObject({ ok: true, accessMode: "selected" });
    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 61 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 24,
        message: "tab 61 access was revoked",
      });
    });
  });

  it("revokes all-mode authority before a queued downgrade reaches the mutation queue", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 204, url: "https://example.com/queued-downgrade", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerEventListener) {
      throw new Error("expected relay and debugger event listener");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 40, tabId: 204 });
    await vi.waitFor(() =>
      expect(harness.debuggerAttach).toHaveBeenCalledWith({ tabId: 204 }, "1.3"),
    );

    harness.storageSet.mockClear();
    socket.send.mockClear();
    const releaseOlderMutation = harness.deferNextStorageSet();
    const olderMutation = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "all",
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "all" }));

    const downgrading = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await expect(
      sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 204 }),
    ).resolves.toMatchObject({ accessible: false });
    harness.debuggerEventListener({ tabId: 204 }, "Runtime.consoleAPICalled", {});
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent"),
    ).toBe(false);

    releaseOlderMutation();
    await expect(olderMutation).resolves.toEqual({ ok: true, accessMode: "all" });
    await expect(downgrading).resolves.toEqual({ ok: true, accessMode: "selected" });
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 204 });
  });

  it("rejects a stale tab action when a queued mode change executes first", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 205, url: "https://example.com/stale-action", groupId: -1 }],
    });
    harness.storageSet.mockClear();
    const releaseModeStorage = harness.deferNextStorageSet();
    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "selected" });
    });

    const staleToggle = sendRuntimeMessage(harness, {
      type: "toggleTabAccess",
      tabId: 205,
      accessMode: "all",
      grant: false,
    });
    releaseModeStorage();

    await expect(changingMode).resolves.toEqual({ ok: true, accessMode: "selected" });
    await expect(staleToggle).resolves.toEqual({
      ok: false,
      error: "Browser access mode changed. Refresh and retry.",
    });
    expect(harness.tabsGroup).not.toHaveBeenCalled();
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
  });

  it("keeps a Selected barrier ahead of a queued All-mode widening", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "selected",
      },
      initialTabs: [{ id: 206, url: "https://example.com/queued-widening", groupId: -1 }],
    });
    harness.storageSet.mockClear();
    const releaseWideningStorage = harness.deferNextStorageSet();
    const widening = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "all",
    });
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "all" });
    });

    const restricting = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    const releaseRestrictingStorage = harness.deferNextStorageSet();
    releaseWideningStorage();
    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "selected" });
    });

    await expect(
      sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 206 }),
    ).resolves.toMatchObject({ accessible: false });

    releaseRestrictingStorage();
    await expect(widening).resolves.toEqual({ ok: true, accessMode: "all" });
    await expect(restricting).resolves.toEqual({ ok: true, accessMode: "selected" });
  });

  it("revalidates a selected survivor that leaves its group during downgrade cleanup", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [
        { id: 211, url: "https://example.com/selected", groupId: 7 },
        { id: 212, url: "https://example.com/unselected", groupId: -1 },
      ],
    });
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerEventListener) {
      throw new Error("expected relay and debugger event listener");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 41, tabId: 211 });
    socket.receive({ type: "attach", seq: 42, tabId: 212 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalledTimes(2));

    let releaseUnselectedDetach = () => {};
    const unselectedDetach = new Promise<void>((resolve) => {
      releaseUnselectedDetach = resolve;
    });
    harness.debuggerDetach.mockImplementation(async ({ tabId }: { tabId: number }) => {
      if (tabId === 212) {
        await unselectedDetach;
      }
    });
    socket.send.mockClear();
    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    await vi.waitFor(() => expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 212 }));

    harness.unshareTab(211);
    harness.tabsUpdatedListener(211, { groupId: -1 });
    releaseUnselectedDetach();

    await expect(changingMode).resolves.toEqual({ ok: true, accessMode: "selected" });
    await vi.waitFor(() => expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 211 }));
    harness.debuggerEventListener({ tabId: 211 }, "Runtime.consoleAPICalled", {});
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent"),
    ).toBe(false);
  });

  it("revokes an ungrouped attach already in flight during all-to-selected downgrade", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 62, url: "https://example.com/attach-race", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    let releaseAttach = () => {};
    harness.debuggerAttach.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseAttach = () => resolve(undefined);
        }),
    );
    socket.receive({ type: "attach", seq: 25, tabId: 62 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());

    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });
    releaseAttach();

    await expect(changingMode).resolves.toMatchObject({ ok: true, accessMode: "selected" });
    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 62 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 25,
        message: "tab 62 access was revoked",
      });
    });
  });

  it("preserves the proven attach epoch across a deferred target lookup", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 63, url: "https://example.com/target-race", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerEventListener) {
      throw new Error("expected relay and debugger event listener");
    }
    await harness.authenticate(socket);
    let releaseTargets = (
      _targets: Array<{ id?: string; tabId?: number; attached?: boolean }>,
    ) => {};
    harness.debuggerGetTargets.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseTargets = resolve;
        }),
    );
    socket.receive({ type: "attach", seq: 26, tabId: 63 });
    await vi.waitFor(() => {
      expect(harness.debuggerAttach).toHaveBeenCalledWith({ tabId: 63 }, "1.3");
      expect(harness.debuggerGetTargets).toHaveBeenCalled();
    });

    const releaseModeStorage = harness.deferNextStorageSet();
    releaseTargets([{ id: "target-63", tabId: 63, attached: true }]);
    const changingMode = sendRuntimeMessage(harness, {
      type: "setAccessMode",
      accessMode: "selected",
    });

    await vi.waitFor(() => {
      expect(harness.storageSet).toHaveBeenCalledWith({ accessMode: "selected" });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 26,
        message: "tab 63 access was revoked",
      });
    });
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 63 });

    harness.debuggerEventListener({ tabId: 63 }, "Runtime.consoleAPICalled", { value: 1 });
    const framesAfterEvent = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(
      framesAfterEvent.some(
        (frame) => frame.type === "cdpEvent" && frame.method === "Runtime.consoleAPICalled",
      ),
    ).toBe(false);

    releaseModeStorage();
    await expect(changingMode).resolves.toEqual({ ok: true, accessMode: "selected" });
  });

  it("does not mint an event epoch when a pending attach is selected again", async () => {
    const harness = await loadBackground({
      initialTabs: [{ id: 64, url: "https://example.com/reselected", groupId: 7 }],
    });
    harness.shareTab(64);
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerEventListener) {
      throw new Error("expected relay and debugger event listener");
    }
    await harness.authenticate(socket);
    let releaseTargets = (
      _targets: Array<{ id?: string; tabId?: number; attached?: boolean }>,
    ) => {};
    harness.debuggerGetTargets.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseTargets = resolve;
        }),
    );
    socket.receive({ type: "attach", seq: 27, tabId: 64 });
    await vi.waitFor(() => expect(harness.debuggerGetTargets).toHaveBeenCalled());

    harness.unshareTab(64);
    harness.tabsUpdatedListener(64, { groupId: -1 });
    harness.shareTab(64);
    harness.tabsUpdatedListener(64, { groupId: 7 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });

    harness.debuggerEventListener({ tabId: 64 }, "Runtime.consoleAPICalled", { value: 1 });
    expect(
      socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .some((frame) => frame.type === "cdpEvent" && frame.method === "Runtime.consoleAPICalled"),
    ).toBe(false);

    releaseTargets([{ id: "target-64", tabId: 64, attached: true }]);
    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 27,
        message: "tab 64 access was revoked",
      });
    });
    expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 64 });
  });

  it.each(["all", "selected"] as const)(
    "keeps an unrelated attachment live while toggling one tab in %s mode",
    async (accessMode) => {
      const groupId = accessMode === "selected" ? 7 : -1;
      const harness = await loadBackground({
        storedConfig: {
          relayUrl: "ws://127.0.0.1:18797/extension",
          token: TEST_RELAY_KEY,
          authVersion: 2,
          accessMode,
        },
        initialTabs: [
          { id: 201, url: "https://example.com/attached", groupId },
          { id: 202, url: "https://example.com/toggle", groupId },
        ],
      });
      const socket = harness.relaySockets[0];
      if (!socket || !harness.debuggerEventListener) {
        throw new Error("expected relay and debugger event listener");
      }
      await harness.authenticate(socket);
      socket.receive({ type: "attach", seq: 28, tabId: 201 });
      socket.receive({ type: "attach", seq: 29, tabId: 202 });
      await vi.waitFor(() => {
        const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
        expect(frames).toContainEqual({
          type: "result",
          seq: 28,
          result: { targetId: "tab-201" },
        });
        expect(frames).toContainEqual({
          type: "result",
          seq: 29,
          result: { targetId: "tab-202" },
        });
      });

      socket.send.mockClear();
      let releaseMutation = () => {};
      if (accessMode === "all") {
        releaseMutation = harness.deferNextSessionStorageSet();
        harness.sessionStorageSet.mockClear();
      } else {
        const pendingDetach = new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
        harness.debuggerDetach.mockImplementation(async ({ tabId }: { tabId: number }) => {
          if (tabId === 202) {
            await pendingDetach;
          }
        });
      }
      const toggling = sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 202,
        accessMode,
        grant: false,
      });
      if (accessMode === "all") {
        await vi.waitFor(() => expect(harness.sessionStorageSet).toHaveBeenCalled());
      } else {
        await vi.waitFor(() => expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 202 }));
      }

      await expect(
        sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 201 }),
      ).resolves.toMatchObject({ accessible: true });
      await expect(
        sendRuntimeMessage(harness, { type: "getTabAccess", tabId: 202 }),
      ).resolves.toMatchObject({ accessible: false });
      harness.debuggerEventListener({ tabId: 201 }, "Runtime.consoleAPICalled", {
        phase: "during",
      });
      harness.debuggerEventListener({ tabId: 202 }, "Runtime.consoleAPICalled", {
        phase: "during",
      });
      expect(
        socket.send.mock.calls
          .map(([raw]) => JSON.parse(raw))
          .filter((frame) => frame.type === "cdpEvent")
          .map((frame) => frame.params?.phase),
      ).toEqual(["during"]);

      releaseMutation();
      await expect(toggling).resolves.toEqual({
        ok: true,
        accessible: false,
        denied: accessMode === "all",
      });

      harness.debuggerEventListener({ tabId: 201 }, "Runtime.consoleAPICalled", {
        phase: "after",
      });
      harness.debuggerEventListener({ tabId: 202 }, "Runtime.consoleAPICalled", {
        phase: "after",
      });
      expect(
        socket.send.mock.calls
          .map(([raw]) => JSON.parse(raw))
          .filter((frame) => frame.type === "cdpEvent")
          .map((frame) => frame.params?.phase),
      ).toEqual(["during", "after"]);
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 202 });
      expect(harness.debuggerDetach).not.toHaveBeenCalledWith({ tabId: 201 });
      expect(harness.debuggerAttach).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["all", "selected"] as const)(
    "republishes restored tab access immediately in %s mode",
    async (accessMode) => {
      const tabId = 203;
      const harness = await loadBackground({
        storedConfig: {
          relayUrl: "ws://127.0.0.1:18797/extension",
          token: TEST_RELAY_KEY,
          authVersion: 2,
          accessMode,
        },
        initialTabs: [
          {
            id: tabId,
            url: "https://example.com/restored",
            groupId: accessMode === "selected" ? 7 : -1,
          },
        ],
      });
      const socket = harness.relaySockets[0];
      if (!socket) {
        throw new Error("expected relay socket");
      }
      await harness.authenticate(socket);

      await expect(
        sendRuntimeMessage(harness, { type: "toggleTabAccess", tabId, accessMode, grant: false }),
      ).resolves.toMatchObject({ ok: true, accessible: false });
      await expect(
        sendRuntimeMessage(harness, { type: "toggleTabAccess", tabId, accessMode, grant: true }),
      ).resolves.toMatchObject({ ok: true, accessible: true, denied: false });

      await vi.waitFor(() => {
        const refreshes = socket.send.mock.calls
          .map(([raw]) => JSON.parse(raw))
          .filter((frame) => frame.type === "tabs");
        expect(refreshes.at(-1)?.tabs).toContainEqual(expect.objectContaining({ tabId }));
      });
    },
  );

  it("refreshes targets on selected-to-all while keeping session-denied tabs hidden", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "selected",
      },
      sessionConfig: { deniedTabIdsV1: [72] },
      initialTabs: [
        { id: 71, url: "https://example.com/available", groupId: -1 },
        { id: 72, url: "https://example.com/paused", groupId: -1 },
      ],
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    await expect(
      sendRuntimeMessage(harness, { type: "setAccessMode", accessMode: "all" }),
    ).resolves.toMatchObject({ ok: true, accessMode: "all" });

    await vi.waitFor(() => {
      const refreshes = socket.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((frame) => frame.type === "tabs");
      expect(refreshes.at(-1)?.tabs).toEqual([expect.objectContaining({ tabId: 71 })]);
    });
  });

  it("keeps detach available as the revocation cleanup command", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.unshareTab(41);

    socket.receive({ type: "detach", seq: 5, tabId: 41 });

    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 41 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({ type: "result", seq: 5, result: {} });
    });
  });

  it("allows createTab and groups the new tab before reporting success", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.tabsCreate.mockResolvedValueOnce({
      id: 42,
      url: "https://example.com",
      active: true,
      windowId: 1,
      groupId: -1,
      incognito: false,
    });

    socket.receive({ type: "createTab", seq: 6, url: "https://example.com" });

    await vi.waitFor(() => {
      expect(harness.tabsGroup).toHaveBeenCalledWith({ tabIds: [42] });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({ type: "result", seq: 6, result: { tabId: 42 } });
    });
  });

  it("invalidates an attach that was in flight when the tab left the group", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    harness.shareTab(43);
    let releaseAttach = () => {};
    harness.debuggerAttach.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseAttach = () => resolve(undefined);
        }),
    );

    socket.receive({ type: "attach", seq: 7, tabId: 43 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalledOnce());
    harness.unshareTab(43);
    harness.tabsUpdatedListener(43, { groupId: -1 });
    await Promise.resolve();
    releaseAttach();

    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 43 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 7,
        message: "tab 43 access was revoked",
      });
    });
  });

  it("persists Cancel as an all-mode session deny, restores with Allow, and prunes on close", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
      },
      initialTabs: [{ id: 81, url: "https://example.com/cancel", groupId: -1 }],
    });
    const socket = harness.relaySockets[0];
    if (!socket || !harness.debuggerDetachListener || !harness.tabsRemovedListener) {
      throw new Error("expected relay and Chrome lifecycle listeners");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 30, tabId: 81 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());

    harness.debuggerDetachListener({ tabId: 81 }, "canceled_by_user");
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]);
    });
    socket.receive({ type: "attach", seq: 31, tabId: 81 });
    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 31,
        message: "tab 81 is paused for OpenClaw",
      });
    });

    await expect(
      sendRuntimeMessage(harness, {
        type: "toggleTabAccess",
        tabId: 81,
        accessMode: "all",
        grant: true,
      }),
    ).resolves.toMatchObject({ ok: true, accessible: true, denied: false });
    expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");

    harness.debuggerDetachListener({ tabId: 81 }, "canceled_by_user");
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues.deniedTabIdsV1).toEqual([81]);
    });
    harness.tabsRemovedListener(81);
    await vi.waitFor(() => {
      expect(harness.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    });
  });

  it("restores a validated Cancel deny after an MV3 worker restart", async () => {
    const storedConfig = {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: "all",
    };
    const initialTabs = [{ id: 91, url: "https://example.com/reload", groupId: -1 }];
    const harness = await loadBackground({
      storedConfig,
      sessionConfig: { deniedTabIdsV1: [91] },
      initialTabs,
    });
    const socket = harness.relaySockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    await harness.authenticate(socket);
    const hello = socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((frame) => frame.type === "hello");
    expect(hello.tabs).toEqual([]);
    socket.receive({ type: "attach", seq: 32, tabId: 91 });
    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 32,
        message: "tab 91 is paused for OpenClaw",
      });
    });
  });

  it.each(["all", "selected"] as const)(
    "keeps agent-created tabs in the OpenClaw group in %s mode",
    async (accessMode) => {
      const harness = await loadBackground({
        storedConfig: {
          relayUrl: "ws://127.0.0.1:18797/extension",
          token: TEST_RELAY_KEY,
          authVersion: 2,
          accessMode,
        },
      });
      const socket = harness.relaySockets[0];
      if (!socket) {
        throw new Error("expected relay socket");
      }
      await harness.authenticate(socket);
      harness.tabsCreate.mockResolvedValueOnce({
        id: 101,
        url: "https://example.com/created",
        active: true,
        groupId: -1,
        windowId: 1,
        incognito: false,
      });
      socket.receive({ type: "createTab", seq: 33, url: "https://example.com/created" });
      await vi.waitFor(() => {
        expect(harness.tabsGroup).toHaveBeenCalledWith({ tabIds: [101] });
      });
    },
  );

  it.each([
    { accessMode: "all" as const, detached: false },
    { accessMode: "selected" as const, detached: true },
  ])("revokes on group removal only in $accessMode mode", async ({ accessMode, detached }) => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode,
      },
      initialTabs: [{ id: 111, url: "https://example.com/group", groupId: 7 }],
    });
    harness.shareTab(111);
    const socket = harness.relaySockets[0];
    if (!socket || !harness.tabGroupRemovedListener) {
      throw new Error("expected relay and tab-group listener");
    }
    await harness.authenticate(socket);
    socket.receive({ type: "attach", seq: 34, tabId: 111 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalled());
    harness.debuggerDetach.mockClear();

    harness.unshareTab(111);
    harness.tabGroupRemovedListener();

    if (detached) {
      await vi.waitFor(() => {
        expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 111 });
      });
    } else {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(harness.debuggerDetach).not.toHaveBeenCalled();
    }
  });
});
