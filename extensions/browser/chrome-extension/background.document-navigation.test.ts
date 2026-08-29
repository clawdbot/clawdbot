import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

const originalUrl = "https://example.com/existing";
const blankResult = { frameId: "root", loaderId: "blank-loader" };

async function setup() {
  const h = await loadBackground({
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: "selected",
    },
    initialTabs: [
      { id: 7, url: originalUrl, groupId: 7, windowId: 1 },
      { id: 8, url: "about:blank", groupId: 7 },
    ],
  });
  const socket = h.relaySockets[0];
  assert(socket);
  await h.authenticate(socket);
  let seq = 1000;
  const frames = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const request = async (message: Record<string, unknown>) => {
    const id = ++seq;
    socket.receive({ ...message, seq: id });
    await vi.waitFor(() => expect(frames().find((frame) => frame.seq === id)).toBeDefined());
    return frames().find((frame) => frame.seq === id);
  };
  expect(await request({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
  const emit = (method: string, params: unknown) =>
    h.debuggerEventListener?.({ tabId: 7 }, method, params);
  const commitBlank = () => {
    h.updateTab(7, { url: "about:blank" });
    emit("Runtime.executionContextsCleared", {});
    emit("Page.frameNavigated", {
      frame: { id: "root", loaderId: "blank-loader", url: "about:blank" },
    });
    emit("Page.lifecycleEvent", { frameId: "root", loaderId: "blank-loader", name: "load" });
  };
  const native = (navigate: () => Promise<Record<string, unknown>>) => {
    h.debuggerSendCommand.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "root", loaderId: "original", url: originalUrl } } };
      }
      return args[1] === "Page.navigate" ? await navigate() : {};
    });
  };
  const navigate = (params: Record<string, unknown> = { url: "about:blank", frameId: "root" }) =>
    request({ type: "cdp", tabId: 7, method: "Page.navigate", params });
  return Object.assign(h, { socket, frames, request, emit, commitBlank, native, navigate });
}

const releases: Array<() => void> = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

describe("commanded existing document navigation", () => {
  it("preserves the native blank/reset/trace/return order in selected mode", async () => {
    const h = await setup();
    h.native(async () => {
      h.commitBlank();
      return blankResult;
    });
    h.socket.send.mockClear();
    expect(
      await h.request({
        type: "cdp",
        tabId: 7,
        method: "Page.navigate",
        params: { url: "about:blank", frameId: "root" },
      }),
    ).toMatchObject({ type: "result", result: blankResult });
    expect(
      h
        .frames()
        .filter((f) => f.type === "cdpEvent" || f.seq)
        .map((f) => f.method ?? f.type),
    ).toEqual([
      "Runtime.executionContextsCleared",
      "Page.frameNavigated",
      "Page.lifecycleEvent",
      "result",
    ]);
    expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
      type: "result",
    });
    expect(await h.request({ type: "attach", tabId: 8 })).toMatchObject({ type: "error" });
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      const get = h.tabsGet.getMockImplementation()!;
      h.tabsGet.mockImplementationOnce(async (id) => {
        const stale = await get(id);
        h.updateTab(id, { url: originalUrl }, false);
        h.emit("Page.frameNavigated", {
          frame: { id: "root", loaderId: "return", url: originalUrl },
        });
        return stale;
      });
      return { frameId: "root", loaderId: "return" };
    });
    expect(
      await h.request({
        type: "cdp",
        tabId: 7,
        method: "Page.navigate",
        params: { url: originalUrl },
      }),
    ).toMatchObject({ type: "result" });
    expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.end" })).toMatchObject({
      type: "result",
    });
    h.updateTab(7, { url: "about:blank" });
    expect(await sendRuntimeMessage(h, { type: "getTabAccess", tabId: 7 })).toMatchObject({
      accessible: false,
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
    expect(h.tabsUpdate).not.toHaveBeenCalled();
  });
  it("honors an explicit close of the controlled blank in selected mode", async () => {
    const h = await setup();
    h.native(async () => {
      h.commitBlank();
      return blankResult;
    });
    expect(await h.navigate()).toMatchObject({ type: "result" });
    expect(await h.request({ type: "closeTab", tabId: 7 })).toMatchObject({ type: "result" });
    expect(h.tabsRemove).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([
    { pendingUrl: "https://example.com/next", response: "result" },
    { pendingUrl: "chrome://settings", response: "error" },
  ])(
    "revalidates Selected pending $pendingUrl between response lookups",
    async ({ pendingUrl, response }) => {
      const h = await setup();
      h.native(async () => {
        h.commitBlank();
        const get = h.tabsGet.getMockImplementation()!;
        h.tabsGet.mockImplementationOnce(async (id) => {
          const stale = await get(id);
          h.updateTab(id, { pendingUrl });
          return stale;
        });
        return blankResult;
      });
      expect(await h.navigate()).toMatchObject({ type: response });
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it("never mints selected access from an unowned or child blank", async () => {
    const h = await setup();
    h.native(async () => blankResult);
    expect(await h.navigate({ url: "about:blank", frameId: "child" })).toMatchObject({
      type: "result",
    });
    expect(
      await h.request({
        type: "cdp",
        tabId: 7,
        sessionId: "child-session",
        method: "Page.navigate",
        params: { url: "about:blank" },
      }),
    ).toMatchObject({ type: "result" });
    h.updateTab(7, { url: "about:blank" });
    expect(
      await h.request({ type: "cdp", tabId: 7, method: "Tracing.start", authorized: true }),
    ).toMatchObject({ type: "error" });
    expect(
      await h.request({
        type: "cdp",
        tabId: 8,
        method: "Page.navigate",
        params: { url: "about:blank" },
      }),
    ).toMatchObject({ type: "error" });
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it("fences a selected reconnect before response without deleting or restoring the tab", async () => {
    const h = await setup();
    const result = createDeferred<Record<string, unknown>>();
    releases.push(() => result.resolve(blankResult));
    h.native(async () => {
      h.commitBlank();
      return await result.promise;
    });
    const navigating = h.navigate();
    await vi.waitFor(() => expect(h.debuggerSendCommand.mock.calls.length).toBe(2));
    h.socket.send.mockClear();
    h.socket.close();
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(2));
    const replacement = h.relaySockets[1];
    assert(replacement);
    await h.authenticate(replacement);
    replacement.receive({ type: "attach", tabId: 7, seq: 9001 });
    await vi.waitFor(() =>
      expect(replacement.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(
        expect.objectContaining({ type: "error", seq: 9001 }),
      ),
    );
    h.emit("Tracing.tracingComplete", { stream: "revoked-stream" });
    result.resolve(blankResult);
    // Closed sockets intentionally cannot receive the old response.
    await expect(navigating).rejects.toThrow();
    expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
    expect(await sendRuntimeMessage(h, { type: "getTabAccess", tabId: 7 })).toMatchObject({
      accessible: false,
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
    expect(h.tabsUpdate).not.toHaveBeenCalled();
  });
  it("does not restore selected navigation provenance after worker restart", async () => {
    const h = await setup();
    h.native(async () => {
      h.commitBlank();
      return blankResult;
    });
    expect(await h.navigate()).toMatchObject({ type: "result" });
    const initialTabs = await h.tabsQuery();
    const storedConfig = { ...h.storageValues };
    const sessionConfig = { ...h.sessionStorageValues };
    await cleanupBackgroundHarnesses();
    vi.resetModules();
    const restarted = await loadBackground({ initialTabs, storedConfig, sessionConfig });
    const socket = restarted.relaySockets[0];
    assert(socket);
    await restarted.authenticate(socket);
    expect(await sendRuntimeMessage(restarted, { type: "getTabAccess", tabId: 7 })).toMatchObject({
      accessible: false,
    });
    expect(restarted.tabsRemove).not.toHaveBeenCalled();
  });
  it("discards a stale selected discovery snapshot of the source before consuming blank provenance", async () => {
    const h = await setup();
    h.native(async () => {
      h.commitBlank();
      return blankResult;
    });
    const staleTabs = await h.tabsQuery();
    const lookup = createDeferred<typeof staleTabs>();
    releases.push(() => lookup.resolve(staleTabs));
    let inspecting = false;
    h.tabsQuery.mockImplementationOnce(async () => {
      inspecting = true;
      return await lookup.promise;
    });
    const status = sendRuntimeMessage(h, { type: "getStatus" });
    await vi.waitFor(() => expect(inspecting).toBe(true));
    expect(await h.navigate()).toMatchObject({ type: "result" });
    lookup.resolve(staleTabs);
    expect(await status).toMatchObject({ accessibleTabCount: 1 });
    expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
      type: "result",
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });
});
