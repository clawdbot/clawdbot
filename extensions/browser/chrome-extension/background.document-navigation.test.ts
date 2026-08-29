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

async function setup(mode: "all" | "selected") {
  const h = await loadBackground({
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: mode,
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
  const native = (navigate: () => Promise<object>) => {
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
  it.each(["all", "selected"] as const)(
    "preserves the native blank/reset/trace/return order in %s mode",
    async (mode) => {
      const h = await setup(mode);
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
    },
  );
  it.each(["all", "selected"] as const)(
    "accepts a source URL fragment from the native frame contract in %s mode",
    async (mode) => {
      const h = await setup(mode);
      h.updateTab(7, { url: `${originalUrl}#section` });
      h.debuggerSendCommand.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: "root",
                loaderId: "original",
                url: originalUrl,
                urlFragment: "#section",
              },
            },
          };
        }
        if (args[1] === "Page.navigate") {
          h.commitBlank();
          return blankResult;
        }
        return {};
      });
      expect(await h.navigate()).toMatchObject({ type: "result", result: blankResult });
      expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
        type: "result",
      });
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it("rejects a native blank commit with an uncommanded URL fragment", async () => {
    const h = await setup("all");
    h.native(async () => {
      h.updateTab(7, { url: "about:blank" });
      h.emit("Page.frameNavigated", {
        frame: { id: "root", loaderId: "blank-loader", url: "about:blank", urlFragment: "#other" },
      });
      return blankResult;
    });
    h.socket.send.mockClear();
    expect(await h.navigate()).toMatchObject({ type: "error" });
    expect(h.frames().filter((frame) => frame.type === "cdpEvent")).toEqual([]);
    expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
      type: "error",
    });
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it.each(["all", "selected"] as const)(
    "accepts a root commit after its native response in %s",
    async (mode) => {
      const h = await setup(mode);
      h.native(async () => blankResult);
      h.socket.send.mockClear();
      expect(await h.navigate()).toMatchObject({ type: "result", result: blankResult });
      expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
        type: "error",
      });
      h.commitBlank();
      expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
        type: "result",
      });
      expect(
        h
          .frames()
          .filter((f) => f.type === "cdpEvent")
          .map((f) => f.method),
      ).toEqual(["Runtime.executionContextsCleared", "Page.frameNavigated", "Page.lifecycleEvent"]);
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it.each([
    { pendingUrl: "https://example.com/next", response: "result" },
    { pendingUrl: "chrome://settings", response: "error" },
  ])(
    "revalidates Selected pending $pendingUrl between response lookups",
    async ({ pendingUrl, response }) => {
      const h = await setup("selected");
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

  it.each([
    "wrong frame",
    "wrong loader",
    "aborted",
    "download",
    "rejected",
    "competing commit",
  ] as const)("discards early events after native %s", async (failure) => {
    const h = await setup("all");
    h.native(async () => {
      h.commitBlank();
      if (failure === "rejected") {
        throw new Error("native failure");
      }
      if (failure === "competing commit") {
        h.updateTab(7, { url: originalUrl });
        h.emit("Page.frameNavigated", {
          frame: { id: "root", loaderId: "competitor", url: originalUrl },
        });
      }
      return {
        ...blankResult,
        ...(failure === "wrong frame" ? { frameId: "child" } : {}),
        ...(failure === "wrong loader" ? { loaderId: "other" } : {}),
        ...(failure === "aborted" ? { errorText: "net::ERR_ABORTED" } : {}),
        ...(failure === "download" ? { isDownload: true } : {}),
      };
    });
    h.socket.send.mockClear();
    expect(await h.navigate()).toMatchObject({ type: "error" });
    expect(h.frames().filter((f) => f.type === "cdpEvent")).toEqual([]);
    h.updateTab(7, { url: "about:blank" });
    expect(await h.request({ type: "attach", tabId: 7 })).toMatchObject({ type: "error" });
    expect(h.tabsRemove).not.toHaveBeenCalled();
    expect(h.tabsUpdate).not.toHaveBeenCalled();
  });

  it.each(["all", "selected"] as const)(
    "never mints %s access from an unowned or child blank",
    async (mode) => {
      const h = await setup(mode);
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
    },
  );

  it.each(["child frame", "child session", "wrong root"] as const)(
    "does not accept a %s commit as root proof",
    async (source) => {
      const h = await setup("all");
      h.native(async () => {
        h.updateTab(7, { url: "about:blank" });
        h.debuggerEventListener?.(
          { tabId: 7, ...(source === "child session" ? { sessionId: "child" } : {}) },
          "Page.frameNavigated",
          {
            frame: {
              id: source === "wrong root" ? "other" : "root",
              loaderId: "blank-loader",
              url: "about:blank",
              ...(source === "child frame" ? { parentId: "parent" } : {}),
            },
          },
        );
        return blankResult;
      });
      await h.navigate();
      expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
        type: "error",
      });
      expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
    },
  );

  it.each(
    (["all", "selected"] as const).flatMap((mode) =>
      (["before response", "while blank"] as const).flatMap((phase) =>
        ["pause", "mode", "remove", "replace", "detach", "unpair", "reconnect"].map((reason) => ({
          mode,
          phase,
          reason,
        })),
      ),
    ),
  )(
    "fences $mode $reason $phase without deleting the existing tab",
    async ({ mode, phase, reason }) => {
      const h = await setup(mode);
      const result = createDeferred<object>();
      releases.push(() => result.resolve(blankResult));
      h.native(async () => {
        h.commitBlank();
        return phase === "before response" ? await result.promise : blankResult;
      });
      const navigating = h.navigate();
      await vi.waitFor(() => expect(h.debuggerSendCommand.mock.calls.length).toBe(2));
      if (phase === "while blank") {
        expect(await navigating).toMatchObject({ type: "result" });
      }
      h.socket.send.mockClear();
      if (reason === "pause") {
        expect(
          await sendRuntimeMessage(h, {
            type: "toggleTabAccess",
            accessMode: mode,
            tabId: 7,
            grant: false,
          }),
        ).toMatchObject({ ok: true, accessible: false });
        if (mode === "all") {
          expect(h.sessionStorageValues.deniedTabIdsV1).toEqual([7]);
        }
      } else if (reason === "mode") {
        await sendRuntimeMessage(h, {
          type: "setAccessMode",
          accessMode: mode === "all" ? "selected" : "all",
        });
      } else if (reason === "remove") {
        h.tabsRemovedListener?.(7);
      } else if (reason === "replace") {
        h.tabsReplacedListener(9, 7);
      } else if (reason === "detach") {
        await h.request({ type: "detach", tabId: 7 });
      } else if (reason === "unpair") {
        await sendRuntimeMessage(h, { type: "unpair" });
      } else {
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
      }
      h.emit("Tracing.tracingComplete", { stream: "revoked-stream" });
      result.resolve(blankResult);
      if (reason === "unpair" || reason === "reconnect") {
        // Closed sockets intentionally cannot receive the old response.
        if (phase === "before response") {
          await expect(navigating).rejects.toThrow();
        }
      } else if (phase === "before response") {
        expect(await navigating).toMatchObject({ type: "error" });
      }
      expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
      expect(await sendRuntimeMessage(h, { type: "getTabAccess", tabId: 7 })).toMatchObject({
        accessible: false,
      });
      expect(h.tabsRemove).not.toHaveBeenCalled();
      expect(h.tabsUpdate).not.toHaveBeenCalled();
    },
  );
  it.each(
    (["all", "selected"] as const).flatMap((mode) =>
      [
        "group move",
        "group rename",
        "group removal",
        "window move",
        "incognito",
        "file pending",
        "internal pending",
        "lookalike blank",
        "user blank",
      ].map((change) => ({ mode, change })),
    ),
  )("retires $mode controlled blank on $change", async ({ mode, change }) => {
    const h = await setup(mode);
    h.native(async () => {
      h.commitBlank();
      return blankResult;
    });
    expect(await h.navigate()).toMatchObject({ type: "result" });
    h.socket.send.mockClear();
    if (change === "group move") {
      h.updateTab(7, { groupId: -1 });
    } else if (change === "group rename") {
      h.tabGroupUpdatedListener?.({ id: 7, title: "Other" });
    } else if (change === "group removal") {
      h.tabGroupRemovedListener?.({ id: 7 });
    } else if (change === "window move") {
      h.updateTab(7, { windowId: 2 });
    } else if (change === "incognito") {
      h.updateTab(7, { incognito: true });
    } else if (change === "file pending") {
      h.updateTab(7, { pendingUrl: "file:///tmp/fixture" });
    } else if (change === "internal pending") {
      h.updateTab(7, { pendingUrl: "chrome://settings" });
    } else if (change === "lookalike blank") {
      h.updateTab(7, { url: "about:blank#other" });
    } else {
      h.emit("Page.frameNavigated", {
        frame: { id: "root", loaderId: "user", url: "about:blank" },
      });
    }
    h.emit("Runtime.consoleAPICalled", { value: "revoked" });
    expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
      type: "error",
    });
    expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
    expect(h.tabsRemove).not.toHaveBeenCalled();
  });

  it.each(["root commit", "detach and reattach", "pause and allow"] as const)(
    "rejects a preflight overtaken by %s",
    async (change) => {
      const h = await setup("all");
      const tree = createDeferred<object>();
      releases.push(() => tree.resolve({}));
      h.debuggerSendCommand.mockImplementationOnce(async () => await tree.promise);
      const navigating = h.navigate();
      await vi.waitFor(() => expect(h.debuggerSendCommand).toHaveBeenCalledOnce());
      if (change === "root commit") {
        h.emit("Page.frameNavigated", {
          frame: { id: "root", loaderId: "new-source", url: originalUrl },
        });
      } else if (change === "detach and reattach") {
        await h.request({ type: "detach", tabId: 7 });
        expect(await h.request({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
      } else {
        for (const grant of [false, true]) {
          await sendRuntimeMessage(h, {
            type: "toggleTabAccess",
            accessMode: "all",
            tabId: 7,
            grant,
          });
        }
      }
      tree.resolve({
        frameTree: { frame: { id: "root", loaderId: "original", url: originalUrl } },
      });
      expect(await navigating).toMatchObject({ type: "error" });
      expect(h.debuggerSendCommand).toHaveBeenCalledOnce();
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it.each(["event count", "event bytes"])(
    "discards an over-budget native buffer by %s",
    async (limit) => {
      const h = await setup("all");
      h.native(async () => {
        h.commitBlank();
        if (limit === "event bytes") {
          h.emit("Runtime.consoleAPICalled", { value: "x".repeat(256 * 1024) });
        } else {
          for (let index = 0; index < 128; index++) {
            h.emit("Runtime.executionContextCreated", { context: { id: index } });
          }
        }
        return blankResult;
      });
      h.socket.send.mockClear();
      expect(await h.navigate()).toMatchObject({ type: "error" });
      expect(h.frames().some((f) => f.type === "cdpEvent")).toBe(false);
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it.each(["all", "selected"] as const)(
    "does not restore %s navigation provenance after worker restart",
    async (mode) => {
      const h = await setup(mode);
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
      expect(await sendRuntimeMessage(restarted, { type: "getTabAccess", tabId: 7 })).toMatchObject(
        { accessible: false },
      );
      expect(restarted.tabsRemove).not.toHaveBeenCalled();
    },
  );
  it.each(
    (["all", "selected"] as const).flatMap((mode) =>
      (["source before blank", "blank before return"] as const).map((snapshot) => ({
        mode,
        snapshot,
      })),
    ),
  )(
    "discards a stale $mode discovery snapshot of $snapshot before consuming provenance",
    async ({ mode, snapshot }) => {
      const h = await setup(mode);
      h.native(async () => {
        h.commitBlank();
        return blankResult;
      });
      if (snapshot === "blank before return") {
        expect(await h.navigate()).toMatchObject({ type: "result" });
      }
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
      if (snapshot === "source before blank") {
        expect(await h.navigate()).toMatchObject({ type: "result" });
      } else {
        h.updateTab(7, { url: originalUrl }, false);
        h.emit("Page.frameNavigated", {
          frame: { id: "root", loaderId: "return", url: originalUrl },
        });
      }
      lookup.resolve(staleTabs);
      expect(await status).toMatchObject({ accessibleTabCount: 1 });
      expect(await h.request({ type: "cdp", tabId: 7, method: "Tracing.start" })).toMatchObject({
        type: "result",
      });
      expect(h.tabsRemove).not.toHaveBeenCalled();
    },
  );
});
