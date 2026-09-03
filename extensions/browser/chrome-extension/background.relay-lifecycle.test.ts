import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";
import { FakeWebSocket } from "./background.test-support.js";

const tabId = 7;
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const frames = (socket: FakeWebSocket): Array<Record<string, unknown>> =>
  socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

async function reply(socket: FakeWebSocket, seq: number, message: Record<string, unknown>) {
  const before = frames(socket).length;
  socket.receive({ seq, ...message });
  return await vi.waitFor(() => {
    const result = frames(socket)
      .slice(before)
      .find((frame) => (message.type === "ping" ? frame.type === "pong" : frame.seq === seq));
    expect(result).toBeDefined();
    return result!;
  });
}

async function fixture() {
  const h = await loadBackground({
    deferSocketClose: true,
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: "all",
    },
    initialTabs: [{ id: tabId, url: "https://example.com/live", groupId: -1, incognito: false }],
  });
  const attached = new Map<number, { runtimeEnabled: boolean }>();
  h.debuggerAttach.mockImplementation(async ({ tabId: id }) => {
    if (attached.has(id)) {
      throw new Error(`Another debugger is already attached to the tab with id: ${id}.`);
    }
    attached.set(id, { runtimeEnabled: false });
  });
  h.debuggerDetach.mockImplementation(async (source) => {
    const id = source.tabId ?? Number(source.targetId?.slice("target-".length));
    if (!attached.delete(id)) {
      throw new Error(`Debugger is not attached to the target with id: target-${id}.`);
    }
    // Native programmatic detach does not emit the user onDetach event.
  });
  h.debuggerGetTargetInfo.mockImplementation(async ({ tabId: id }) => {
    if (!attached.has(id)) {
      throw new Error("Debugger is not attached");
    }
    return { targetInfo: { targetId: `target-${id}` } };
  });
  h.debuggerSendCommand.mockImplementation(async (source, method) => {
    const session = attached.get(source.tabId);
    if (!session) {
      throw new Error("Debugger is not attached");
    }
    if (method === "Runtime.enable" && !session.runtimeEnabled) {
      session.runtimeEnabled = true;
      h.debuggerEventListener?.(source, "Runtime.executionContextCreated", {
        context: { id: 3, auxData: { isDefault: true } },
      });
    }
    return {};
  });
  const old = h.relaySockets[0]!;
  await h.authenticate(old);
  async function replacement() {
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(2));
    const socket = h.relaySockets[1]!;
    await h.authenticate(socket);
    return socket;
  }
  async function attach(socket: FakeWebSocket, seq = 1) {
    expect(await reply(socket, seq, { type: "attach", tabId })).toMatchObject({
      type: "result",
      result: { targetId: `target-${tabId}` },
    });
  }
  return { h, old, attached, replacement, attach };
}

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authenticated relay debugger lifetime", () => {
  it.each(["close", "closing replacement", "closed replacement", "auth failure", "explicit pair"])(
    "starts a fresh Runtime after %s without changing grants",
    async (ending) => {
      const f = await fixture();
      await f.attach(f.old);
      await reply(f.old, 2, { type: "cdp", tabId, method: "Runtime.enable" });
      // An unrelated extension debugger target is not owned by this transport.
      f.attached.set(99, { runtimeEnabled: true });
      if (ending === "close") {
        f.old.finishClose();
      }
      if (ending === "closing replacement") {
        f.old.close();
      }
      if (ending === "closed replacement") {
        f.old.readyState = FakeWebSocket.CLOSED;
      }
      if (ending === "auth failure") {
        f.old.receive({ type: "auth.invalid" });
        await vi.waitFor(() => expect(f.old.close).toHaveBeenCalled());
      }
      if (ending === "explicit pair") {
        expect(
          await sendRuntimeMessage(f.h, {
            type: "pair",
            pairingString: `ws://127.0.0.1:18797/extension#${TEST_RELAY_KEY}`,
            accessMode: "all",
          }),
        ).toMatchObject({ ok: true });
      }
      const next = await f.replacement();
      await f.attach(next);
      await reply(next, 2, { type: "cdp", tabId, method: "Runtime.enable" });
      expect(
        frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
      ).toHaveLength(1);
      expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: `target-${tabId}` });
      expect(f.h.debuggerDetach).not.toHaveBeenCalledWith({ targetId: "target-99" });
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
      expect(f.h.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
      expect(await sendRuntimeMessage(f.h, { type: "getTabAccess", tabId })).toMatchObject({
        accessible: true,
        denied: false,
      });
    },
  );

  it.each(["attach", "target lookup"])(
    "drains a delayed old %s and detach before replacement attachment",
    async (phase) => {
      const f = await fixture();
      const gate = createDeferred<void>();
      const detachGate = createDeferred<void>();
      const attachImpl = f.h.debuggerAttach.getMockImplementation()!;
      const targetsImpl = f.h.debuggerGetTargetInfo.getMockImplementation()!;
      if (phase === "attach") {
        f.h.debuggerAttach.mockImplementationOnce(async (...args) => {
          await gate.promise;
          await attachImpl(...args);
        });
      } else {
        f.h.debuggerGetTargetInfo.mockImplementationOnce(async (source) => {
          await gate.promise;
          return targetsImpl(source);
        });
      }
      const detachImpl = f.h.debuggerDetach.getMockImplementation()!;
      f.h.debuggerDetach.mockImplementationOnce(async (source) => {
        await detachGate.promise;
        await detachImpl(source);
      });
      try {
        f.old.receive({ type: "attach", seq: 44, tabId });
        await vi.waitFor(() =>
          expect(
            phase === "attach" ? f.h.debuggerAttach : f.h.debuggerGetTargetInfo,
          ).toHaveBeenCalled(),
        );
        f.old.close();
        const next = await f.replacement();
        next.receive({ type: "attach", seq: 1, tabId });
        await reply(next, 2, { type: "ping" });
        expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
        expect(frames(next).some((frame) => frame.seq === 1)).toBe(false);
        gate.resolve();
        await vi.waitFor(() =>
          expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: `target-${tabId}` }),
        );
        expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
        detachGate.resolve();
        await vi.waitFor(() =>
          expect(frames(next)).toContainEqual({
            type: "result",
            seq: 1,
            result: { targetId: "target-7" },
          }),
        );
        expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
        const detaches = f.h.debuggerDetach.mock.calls.length;
        f.old.finishClose();
        await reply(next, 3, { type: "cdp", tabId, method: "Runtime.enable" });
        expect(f.h.debuggerDetach).toHaveBeenCalledTimes(detaches);
        expect(frames(next).some((frame) => frame.seq === 44)).toBe(false);
        expect(
          frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
        ).toHaveLength(1);
      } finally {
        gate.resolve();
        detachGate.resolve();
        await flush();
      }
    },
  );

  it("detaches without waiting for old evaluation and never delivers its reply on a colliding new seq", async () => {
    const f = await fixture();
    await f.attach(f.old);
    const gate = createDeferred<Record<string, unknown>>();
    f.h.debuggerSendCommand.mockImplementationOnce(async () => await gate.promise);
    try {
      f.old.receive({ type: "cdp", seq: 9, tabId, method: "Runtime.evaluate" });
      await vi.waitFor(() => expect(f.h.debuggerSendCommand).toHaveBeenCalled());
      f.old.finishClose();
      const next = await f.replacement();
      await f.attach(next);
      expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: `target-${tabId}` });
      await reply(next, 9, { type: "cdp", tabId, method: "Runtime.enable" });
      gate.resolve({ stale: true });
      await flush();
      await reply(next, 10, { type: "ping" });
      expect(frames(next).filter((frame) => frame.seq === 9)).toEqual([
        { type: "result", seq: 9, result: {} },
      ]);
      expect(frames(f.old).some((frame) => frame.seq === 9)).toBe(false);
    } finally {
      gate.resolve({});
      await flush();
    }
  });

  it.each(["attach", "cdp", "activateTab", "closeTab", "createTab"])(
    "fences %s paused over a tab lookup while preserving creator-owned rollback",
    async (type) => {
      const f = await fixture();
      await f.attach(f.old);
      const gate = createDeferred<void>();
      const getTab = f.h.tabsGet.getMockImplementation()!;
      f.h.tabsGet.mockClear();
      f.h.tabsGet.mockImplementationOnce(async (id) => {
        await gate.promise;
        return getTab(id);
      });
      try {
        f.old.receive({
          type,
          seq: 8,
          tabId,
          method: "Runtime.evaluate",
          url: "https://example.com/new",
        });
        await vi.waitFor(() => expect(f.h.tabsGet).toHaveBeenCalled());
        f.old.finishClose();
        const next = await f.replacement();
        gate.resolve();
        await flush();
        await f.attach(next);
        expect(f.h.debuggerSendCommand).not.toHaveBeenCalled();
        expect(f.h.tabsUpdate).not.toHaveBeenCalled();
        expect(f.h.windowsUpdate).not.toHaveBeenCalled();
        if (type === "createTab") {
          expect(f.h.tabsRemove).toHaveBeenCalledExactlyOnceWith(tabId + 1);
          expect(await f.h.tabsQuery()).toEqual([expect.objectContaining({ id: tabId })]);
        } else {
          expect(f.h.tabsRemove).not.toHaveBeenCalled();
        }
        expect(f.h.tabsGroup).not.toHaveBeenCalled();
        expect(frames(next).some((frame) => frame.seq === 8)).toBe(false);
        expect(frames(f.old).some((frame) => frame.seq === 8)).toBe(false);
      } finally {
        gate.resolve();
        await flush();
      }
    },
  );

  it("never admits replacement CDP work into the retiring physical session", async () => {
    const f = await fixture();
    await f.attach(f.old);
    const gate = createDeferred<void>();
    const detach = f.h.debuggerDetach.getMockImplementation()!;
    f.h.debuggerDetach.mockImplementationOnce(async (source) => {
      await gate.promise;
      await detach(source);
    });
    try {
      f.old.finishClose();
      const next = await f.replacement();
      next.receive({ type: "cdp", seq: 9, tabId, method: "Runtime.evaluate" });
      await reply(next, 10, { type: "ping" });
      expect(f.h.debuggerSendCommand).not.toHaveBeenCalled();
      gate.resolve();
      await vi.waitFor(() =>
        expect(frames(next)).toContainEqual({
          type: "error",
          seq: 9,
          message: expect.stringContaining("not attached"),
        }),
      );
      await f.attach(next);
      await reply(next, 11, { type: "cdp", tabId, method: "Runtime.enable" });
      expect(
        frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
      ).toHaveLength(1);
    } finally {
      gate.resolve();
      await flush();
    }
  });

  it("does not recapture attach authority revoked while a previous socket drains", async () => {
    const f = await fixture();
    await f.attach(f.old);
    const gate = createDeferred<void>();
    const detach = f.h.debuggerDetach.getMockImplementation()!;
    f.h.debuggerDetach.mockImplementationOnce(async (source) => {
      await gate.promise;
      await detach(source);
    });
    try {
      f.old.finishClose();
      const next = await f.replacement();
      next.receive({ type: "attach", seq: 9, tabId });
      await reply(next, 10, { type: "ping" });
      f.h.updateTab(tabId, { url: "chrome://settings" });
      f.h.updateTab(tabId, { url: "https://example.com/returned" });
      gate.resolve();
      await vi.waitFor(() =>
        expect(frames(next)).toContainEqual({
          type: "error",
          seq: 9,
          message: expect.stringContaining("access was revoked"),
        }),
      );
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
      await f.attach(next, 11);
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await flush();
    }
  });

  it("keeps retirement fenced through an opening deadline and delayed stale close", async () => {
    const f = await fixture();
    await f.attach(f.old);
    const gate = createDeferred<void>();
    const detach = f.h.debuggerDetach.getMockImplementation()!;
    f.h.debuggerDetach.mockImplementationOnce(async (source) => {
      await gate.promise;
      await detach(source);
    });
    try {
      f.old.close();
      f.h.alarmListener({ name: "openclaw-relay-watchdog" });
      await vi.waitFor(() => expect(f.h.relaySockets).toHaveLength(2));
      const expired = f.h.relaySockets[1]!;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
      f.h.alarmListener({ name: "openclaw-relay-opening-deadline" });
      clock.mockRestore();
      expect(expired.close).toHaveBeenCalledWith(4001, "relay authentication timed out");
      f.h.alarmListener({ name: "openclaw-relay-watchdog" });
      await vi.waitFor(() => expect(f.h.relaySockets).toHaveLength(3));
      const next = f.h.relaySockets[2]!;
      await f.h.authenticate(next);
      next.receive({ type: "attach", seq: 1, tabId });
      await reply(next, 2, { type: "ping" });
      expect(frames(next).some((frame) => frame.seq === 1)).toBe(false);
      f.old.finishClose();
      expired.finishClose();
      gate.resolve();
      await vi.waitFor(() =>
        expect(frames(next)).toContainEqual({
          type: "result",
          seq: 1,
          result: { targetId: "target-7" },
        }),
      );
      await reply(next, 3, { type: "cdp", tabId, method: "Runtime.enable" });
      expect(
        frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
      ).toHaveLength(1);
    } finally {
      gate.resolve();
      await flush();
    }
  });

  it("keeps independent live commands concurrent", async () => {
    const f = await fixture();
    await f.attach(f.old);
    const gate = createDeferred<Record<string, unknown>>();
    f.h.debuggerSendCommand.mockImplementationOnce(async () => await gate.promise);
    try {
      f.old.receive({ type: "cdp", seq: 2, tabId, method: "Runtime.evaluate" });
      await vi.waitFor(() => expect(f.h.debuggerSendCommand).toHaveBeenCalled());
      expect(
        await reply(f.old, 3, { type: "cdp", tabId, method: "Page.getFrameTree" }),
      ).toMatchObject({ type: "result" });
      expect(frames(f.old).some((frame) => frame.seq === 2)).toBe(false);
    } finally {
      gate.resolve({});
      await flush();
    }
  });

  it("fails closed when physical retirement cannot prove detach", async () => {
    const f = await fixture();
    await f.attach(f.old);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.h.debuggerDetach.mockRejectedValue(new Error("native detach refused"));
    f.old.finishClose();
    const next = await f.replacement();
    expect(await reply(next, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("native detach refused"),
    });
    expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
  });

  it("does not adopt or retire an attachment when Chrome rejects ownership", async () => {
    const f = await fixture();
    f.attached.set(tabId, { runtimeEnabled: true });
    expect(await reply(f.old, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("Another debugger is already attached"),
    });
    f.old.finishClose();
    const next = await f.replacement();
    expect(await reply(next, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("Another debugger is already attached"),
    });
    expect(f.h.debuggerDetach).not.toHaveBeenCalled();
    expect(f.attached.get(tabId)).toEqual({ runtimeEnabled: true });
  });

  it.each([
    "Debugger is not attached to the target with id: target-7.",
    "No target with given id target-7.",
  ])("accepts Chrome's terminal detach evidence: %s", async (message) => {
    const f = await fixture();
    await f.attach(f.old);
    f.attached.delete(tabId);
    f.h.debuggerDetach.mockRejectedValueOnce(new Error(message));
    f.old.finishClose();
    const next = await f.replacement();
    await f.attach(next);
    await reply(next, 2, { type: "cdp", tabId, method: "Runtime.enable" });
    expect(
      frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
    ).toHaveLength(1);
  });

  it("keeps renewed navigation authority after reconnect without forwarding retired-owner events", async () => {
    const f = await fixture();
    await f.attach(f.old);
    f.old.finishClose();
    f.h.debuggerEventListener?.({ tabId }, "Runtime.executionContextCreated", {
      context: { id: 8 },
    });
    const next = await f.replacement();
    await f.attach(next);
    const gate = createDeferred<void>();
    const getTab = f.h.tabsGet.getMockImplementation()!;
    f.h.tabsGet.mockImplementationOnce(async (id) => {
      await gate.promise;
      return getTab(id);
    });
    try {
      f.h.tabsUpdatedListener(
        tabId,
        { url: "https://example.com/next" },
        { id: tabId, url: "https://example.com/next", groupId: -1, incognito: false },
      );
      f.h.debuggerEventListener?.({ tabId }, "Runtime.executionContextCreated", {
        context: { id: 9 },
      });
      expect(
        frames(next).filter((frame) => frame.method === "Runtime.executionContextCreated"),
      ).toEqual([
        {
          type: "cdpEvent",
          tabId,
          method: "Runtime.executionContextCreated",
          params: { context: { id: 9 } },
        },
      ]);
    } finally {
      gate.resolve();
      await flush();
    }
  });
});

describe("same-transport native generation", () => {
  it.each(["before dispatch", "native completion", "post-access completion"])(
    "rejects old work held at %s across detach and reattach",
    async (stage) => {
      const f = await fixture();
      await f.attach(f.old);
      const gate = createDeferred<void>();
      const entered = createDeferred<void>();
      const getTab = f.h.tabsGet.getMockImplementation()!;
      const holdAccess = () =>
        f.h.tabsGet.mockImplementationOnce(async (id) => {
          entered.resolve();
          await gate.promise;
          return getTab(id);
        });
      if (stage === "before dispatch") {
        holdAccess();
      } else {
        f.h.debuggerSendCommand.mockImplementationOnce(async () => {
          if (stage === "native completion") {
            entered.resolve();
            await gate.promise;
          } else {
            holdAccess();
          }
          return { oldGeneration: true };
        });
      }
      try {
        f.old.receive({ type: "cdp", seq: 90, tabId, method: "Runtime.evaluate" });
        await entered.promise;
        await reply(f.old, 91, { type: "detach", tabId });
        await f.attach(f.old, 92);
        gate.resolve();
        await vi.waitFor(() =>
          expect(frames(f.old).find((frame) => frame.seq === 90)).toMatchObject({ type: "error" }),
        );
        expect(f.h.debuggerSendCommand).toHaveBeenCalledTimes(stage === "before dispatch" ? 0 : 1);
        expect(
          await reply(f.old, 93, { type: "cdp", tabId, method: "Runtime.enable" }),
        ).toMatchObject({ type: "result" });
      } finally {
        gate.resolve();
        await flush();
      }
    },
  );
});

describe("native attachment retirement ordering", () => {
  it("fences creation handoff after native replacement and preserves a user-taken-over tab", async () => {
    const f = await fixture();
    const gate = createDeferred<void>();
    f.h.windowsUpdate.mockImplementationOnce(async () => {
      await gate.promise;
      return undefined;
    });
    const createdTabId = tabId + 1;
    try {
      f.old.receive({ type: "createTab", seq: 80, url: "https://example.com/new", focus: true });
      await vi.waitFor(() => expect(f.h.windowsUpdate).toHaveBeenCalled());
      await reply(f.old, 81, { type: "detach", tabId: createdTabId });
      expect(await reply(f.old, 82, { type: "attach", tabId: createdTabId })).toMatchObject({
        type: "result",
      });
      f.h.updateTab(createdTabId, { url: "https://example.com/user-takeover" });
      gate.resolve();
      await vi.waitFor(() =>
        expect(frames(f.old).find((frame) => frame.seq === 80)).toMatchObject({ type: "error" }),
      );
      expect(f.h.tabsRemove).not.toHaveBeenCalled();
      expect(
        await reply(f.old, 83, { type: "cdp", tabId: createdTabId, method: "Runtime.enable" }),
      ).toMatchObject({ type: "result" });
    } finally {
      gate.resolve();
      await flush();
    }
  });

  it("does not hand off a pending native attach overtaken by explicit detach", async () => {
    const f = await fixture();
    const gate = createDeferred<void>();
    const detachGate = createDeferred<void>();
    const nativeAttach = f.h.debuggerAttach.getMockImplementation()!;
    const nativeDetach = f.h.debuggerDetach.getMockImplementation()!;
    f.h.debuggerAttach.mockImplementationOnce(async (...args) => {
      await gate.promise;
      await nativeAttach(...args);
    });
    f.h.debuggerDetach.mockImplementationOnce(async (...args) => {
      await detachGate.promise;
      await nativeDetach(...args);
    });
    try {
      f.old.receive({ type: "attach", seq: 70, tabId });
      await vi.waitFor(() => expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1));
      f.old.receive({ type: "detach", seq: 71, tabId });
      f.old.receive({ type: "attach", seq: 72, tabId });
      await reply(f.old, 73, { type: "ping" });
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
      gate.resolve();
      await vi.waitFor(() => expect(f.h.debuggerDetach).toHaveBeenCalled());
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
      detachGate.resolve();
      await vi.waitFor(() =>
        expect(frames(f.old).find((frame) => frame.seq === 72)).toMatchObject({ type: "result" }),
      );
      expect(frames(f.old).find((frame) => frame.seq === 70)).toMatchObject({ type: "error" });
    } finally {
      gate.resolve();
      detachGate.resolve();
      await flush();
    }
  });

  it.each(["native detach", "removal", "access loss"])(
    "synchronously invalidates commands before %s reconciliation awaits",
    async (ending) => {
      const f = await fixture();
      await f.attach(f.old);
      const gate = createDeferred<void>();
      const getTab = f.h.tabsGet.getMockImplementation()!;
      f.h.tabsGet.mockClear();
      f.h.tabsGet.mockImplementationOnce(async (id) => {
        await gate.promise;
        return getTab(id);
      });
      try {
        f.old.receive({ type: "cdp", seq: 60, tabId, method: "Runtime.evaluate" });
        await vi.waitFor(() => expect(f.h.tabsGet).toHaveBeenCalled());
        if (ending === "native detach") {
          f.attached.delete(tabId);
          f.h.debuggerDetachListener?.({ tabId }, "target_closed");
        } else if (ending === "removal") {
          f.attached.delete(tabId);
          f.h.tabsRemovedListener?.(tabId);
        } else {
          f.h.updateTab(tabId, { url: "chrome://settings" });
          await vi.waitFor(() => expect(f.h.debuggerDetach).toHaveBeenCalled());
          f.h.updateTab(tabId, { url: "https://example.com/returned" });
        }
        await f.attach(f.old, 61);
        gate.resolve();
        await vi.waitFor(() =>
          expect(frames(f.old).find((frame) => frame.seq === 60)).toMatchObject({ type: "error" }),
        );
        expect(f.h.debuggerSendCommand).not.toHaveBeenCalled();
        expect(
          await reply(f.old, 62, { type: "cdp", tabId, method: "Runtime.enable" }),
        ).toMatchObject({ type: "result" });
      } finally {
        gate.resolve();
        await flush();
      }
    },
  );
});

it("cancels attach admission when a same-socket detach arrives before native dispatch", async () => {
  const f = await fixture();
  f.old.receive({ type: "attach", seq: 51, tabId });
  f.old.receive({ type: "detach", seq: 52, tabId });
  f.old.receive({ type: "attach", seq: 53, tabId });
  await vi.waitFor(() =>
    expect(frames(f.old).find((frame) => frame.seq === 53)).toMatchObject({ type: "result" }),
  );
  expect(frames(f.old).find((frame) => frame.seq === 51)).toMatchObject({ type: "error" });
  expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
});

it.each(["socket close", "native replacement"])(
  "rolls back only its created tab after %s during focus",
  async (ending) => {
    const f = await fixture();
    const gate = createDeferred<void>();
    f.h.windowsUpdate.mockImplementationOnce(async () => {
      await gate.promise;
      return undefined;
    });
    try {
      f.old.receive({ type: "createTab", seq: 80, url: "https://example.com/new", focus: true });
      await vi.waitFor(() => expect(f.h.windowsUpdate).toHaveBeenCalled());
      if (ending === "socket close") {
        f.old.finishClose();
      } else {
        await reply(f.old, 81, { type: "detach", tabId: tabId + 1 });
        expect(await reply(f.old, 82, { type: "attach", tabId: tabId + 1 })).toMatchObject({
          type: "result",
        });
      }
      gate.resolve();
      await vi.waitFor(() => expect(f.h.tabsRemove).toHaveBeenCalledExactlyOnceWith(tabId + 1));
      expect(await f.h.tabsQuery()).toEqual([expect.objectContaining({ id: tabId })]);
      expect(frames(f.old).some((frame) => frame.seq === 80 && frame.type === "result")).toBe(
        false,
      );
    } finally {
      gate.resolve();
      await flush();
    }
  },
);
