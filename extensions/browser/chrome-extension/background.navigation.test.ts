import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadRelayCommandHarness as createHarness,
  sendRuntimeMessage,
  REPLACEMENT_TEST_RELAY_KEY,
} from "./background.test-harness.js";

const releases = new Set<() => void>();
function deferred<T>(value: T) {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  const release = () => {
    releases.delete(release);
    resolve(value);
  };
  releases.add(release);
  return { promise, resolve: release };
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases) {
    release();
  }
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

describe.each(["all", "selected"] as const)("navigation command authority in %s mode", (mode) => {
  it.each(
    ["about:blank", "https://example.com/start"].flatMap((url) =>
      ["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"].flatMap((method) =>
        [true, false].map((commitFirst) => ({ url, method, commitFirst })),
      ),
    ),
  )(
    "completes $method from $url (commit first: $commitFirst)",
    async ({ url, method, commitFirst }) => {
      const harness = await createHarness(mode);
      expect(await harness.command({ type: "createTab", url })).toMatchObject({ type: "result" });
      const completed = deferred({ frameId: "frame-101", loaderId: "next-document" });
      harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
      const navigating = harness.command({
        type: "cdp",
        tabId: 101,
        method,
        params: method === "Page.navigate" ? { url: "https://example.com/next" } : { entryId: 2 },
      });
      await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
      const commit = () => {
        harness.updateTab(
          101,
          method === "Page.reload"
            ? { status: "loading" }
            : { url: "https://example.com/next", pendingUrl: undefined },
        );
        harness.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
          frame: { id: "frame-101" },
        });
        harness.debuggerEventListener?.({ tabId: 101 }, "Page.lifecycleEvent", { name: "load" });
      };
      if (commitFirst) {
        commit();
      }
      completed.resolve();
      expect(await navigating).toMatchObject({
        type: "result",
        result: { loaderId: "next-document" },
      });
      if (!commitFirst) {
        commit();
      }
      expect(
        await harness.command({ type: "cdp", tabId: 101, method: "Runtime.evaluate" }),
      ).toMatchObject({ type: "result" });
      expect(
        harness
          .frames()
          .filter((f) => f.type === "cdpEvent")
          .map((f) => f.method),
      ).toEqual(["Page.frameNavigated", "Page.lifecycleEvent"]);
    },
  );

  it("retires stale page data across a reload without a URL change", async () => {
    const harness = await createHarness(mode);
    await harness.command({ type: "createTab", url: "https://example.com/same" });
    const completed = deferred({});
    harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
    const reading = harness.command({ type: "cdp", tabId: 101, method: "Runtime.evaluate" });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    harness.updateTab(101, { status: "loading" });
    completed.resolve();
    expect(await reading).toMatchObject({ type: "error" });
  });

  it.each([
    ["Page.enable", true],
    ["Debugger.enable", true],
    ["Emulation.setFocusEmulationEnabled", true],
    ["Runtime.evaluate", false],
    ["Input.dispatchMouseEvent", false],
    ["Page.getFrameTree", false],
    ["Page.getResourceTree", false],
    ["Page.createIsolatedWorld", false],
    ["Runtime.getIsolateId", false],
    ["Storage.getStorageKey", false],
  ] as const)("keeps %s completion scoped correctly during a commit", async (method, succeeds) => {
    const harness = await createHarness(mode);
    await harness.command({ type: "createTab", url: "about:blank" });
    const completed = deferred({});
    harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
    const executing = harness.command({ type: "cdp", tabId: 101, method });
    await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
    harness.updateTab(101, { url: "https://example.com/next" });
    completed.resolve();
    expect(await executing).toMatchObject({ type: succeeds ? "result" : "error" });
  });

  it.each([
    "pause",
    "cancel",
    "group",
    "mode",
    "replacement",
    "removal",
    "restricted",
    "pending",
    "file",
    "incognito",
  ])(
    "rejects navigation completion after %s even if an ordinary document returns",
    async (revocation) => {
      const harness = await createHarness(mode);
      await harness.command({ type: "createTab", url: "about:blank" });
      const completed = deferred({});
      harness.debuggerSendCommand.mockImplementationOnce(async () => await completed.promise);
      const navigating = harness.command({
        type: "cdp",
        tabId: 101,
        method: "Page.navigate",
        params: { url: "https://example.com/next" },
      });
      await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
      harness.updateTab(101, { url: "https://example.com/next" });
      switch (revocation) {
        case "pause":
          await sendRuntimeMessage(harness, {
            type: "toggleTabAccess",
            tabId: 101,
            accessMode: mode,
            grant: false,
          });
          break;
        case "cancel":
          harness.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user");
          break;
        case "group":
          if (mode === "all") {
            await sendRuntimeMessage(harness, { type: "setAccessMode", accessMode: "selected" });
          }
          harness.updateTab(101, { groupId: -1 });
          break;
        case "mode":
          await sendRuntimeMessage(harness, {
            type: "setAccessMode",
            accessMode: mode === "all" ? "selected" : "all",
          });
          break;
        case "replacement":
          harness.tabsReplacedListener(102, 101);
          break;
        case "removal":
          harness.tabsRemovedListener?.(101);
          break;
        case "restricted":
          harness.updateTab(101, { url: "chrome://settings" });
          break;
        case "pending":
          harness.updateTab(101, { pendingUrl: "chrome://settings" });
          break;
        case "file":
          harness.updateTab(101, { url: "file:///tmp/private.html" });
          break;
        case "incognito":
          harness.updateTab(101, { incognito: true, url: "https://example.com/private" });
          break;
      }
      harness.updateTab(101, {
        url: "https://example.com/returned",
        pendingUrl: undefined,
        incognito: false,
      });
      completed.resolve();
      expect(await navigating).toMatchObject({ type: "error" });
      expect(harness.tabsRemove).not.toHaveBeenCalled();
    },
  );

  it.each(["unpair", "replacement"])(
    "never replies to a navigation through socket %s",
    async (revocation) => {
      const harness = await createHarness(mode);
      await harness.command({ type: "createTab", url: "about:blank" });
      const completed = deferred({});
      let returned = false;
      harness.debuggerSendCommand.mockImplementationOnce(async () => {
        await completed.promise;
        returned = true;
        return {};
      });
      harness.socket.receive({
        type: "cdp",
        seq: 70,
        tabId: 101,
        method: "Page.navigate",
        params: { url: "https://example.com/next" },
      });
      await vi.waitFor(() => expect(harness.debuggerSendCommand).toHaveBeenCalled());
      const mutation = sendRuntimeMessage(
        harness,
        revocation === "unpair"
          ? { type: "unpair" }
          : {
              type: "pair",
              accessMode: mode,
              pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_TEST_RELAY_KEY}`,
            },
      );
      await vi.waitFor(() => expect(harness.socket.close).toHaveBeenCalled());
      completed.resolve();
      await mutation;
      await vi.waitFor(() => expect(returned).toBe(true));
      if (revocation === "replacement") {
        const socket = harness.relaySockets.at(-1)!;
        await harness.authenticate(socket);
        expect(
          socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).some((f) => f.seq === 70),
        ).toBe(false);
      }
      expect(harness.frames().some((f) => f.seq === 70)).toBe(false);
    },
  );
});
