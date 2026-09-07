import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";

const releases: Array<() => void> = [];
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const h = await loadBackground({
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode: "all",
    },
    initialTabs: [7, 8, 9].map((id) => ({ id, url: `https://example.com/${id}`, groupId: -1 })),
  });
  // Chrome's tab lookup and its extension client registry have different lifetimes.
  const tabs = new Map<number, string>();
  const clients = new Set<string>();
  let ordinal = 0;
  const resolve = (source: { tabId?: number; targetId?: string }) => {
    const id = source.targetId ?? (source.tabId === undefined ? undefined : tabs.get(source.tabId));
    if (!id) {
      throw new Error(`No tab with given id ${source.tabId}.`);
    }
    if (!clients.has(id)) {
      throw new Error(`Debugger is not attached to the target with id: ${id}.`);
    }
    return id;
  };
  h.debuggerAttach.mockImplementation(async ({ tabId }) => {
    if (tabs.has(tabId) && clients.has(tabs.get(tabId)!)) {
      throw new Error("Another debugger is already attached");
    }
    const id = `native-${++ordinal}`;
    tabs.set(tabId, id);
    clients.add(id);
  });
  h.debuggerDetach.mockImplementation(async (source) => {
    clients.delete(resolve(source));
  });
  h.debuggerGetTargets.mockImplementation(async () =>
    [...tabs].map(([tabId, id]) => ({ tabId, id, attached: clients.has(id) })),
  );
  h.debuggerGetTargetInfo.mockImplementation(async (source) => ({
    targetInfo: { targetId: resolve(source) },
  }));
  h.debuggerSendCommand.mockImplementation(async (source, method) => {
    const targetId = resolve(source);
    return method === "Target.getTargetInfo"
      ? { targetInfo: { targetId, type: "page" } }
      : { targetId };
  });
  const socket = h.relaySockets[0]!;
  await h.authenticate(socket);
  let seq = 0;
  const frames = (s = socket) => s.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const command = async (type: string, tabId: number, s = socket) => {
    const id = ++seq;
    s.receive({ type, tabId, seq: id });
    return await vi.waitFor(() => {
      const result = frames(s).find((f) => f.seq === id);
      expect(result).toBeDefined();
      return result;
    });
  };
  const attach = async (tabId: number, s = socket) => {
    const response = await command("attach", tabId, s);
    expect(response).toMatchObject({ type: "result", result: { targetId: tabs.get(tabId) } });
    return tabs.get(tabId)!;
  };
  const reconnect = async () => {
    socket.close();
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(2));
    const next = h.relaySockets[1]!;
    await h.authenticate(next);
    return next;
  };
  const holdDetach = (tabId: number) => {
    const gate = createDeferred<void>();
    releases.push(() => gate.resolve());
    const id = tabs.get(tabId);
    const original = h.debuggerDetach.getMockImplementation()!;
    h.debuggerDetach.mockImplementation(async (source) => {
      if (resolve(source) === id) {
        await gate.promise;
      }
      await original(source);
    });
    return gate;
  };
  return { h, socket, tabs, clients, command, attach, reconnect, frames, holdDetach };
}

describe("native debugger cleanup debt", () => {
  it("keeps a refused tab local while draining another tab and admitting an unrelated tab", async () => {
    const f = await fixture();
    const oldA = await f.attach(7);
    await f.attach(8);
    const gate = f.holdDetach(8);
    f.h.debuggerDetach.mockRejectedValueOnce(new Error("native cleanup refused"));
    const next = await f.reconnect();
    expect.soft(await f.command("attach", 9, next)).toMatchObject({ type: "result" });
    expect(f.clients.has(oldA)).toBe(true);
    let completed = false;
    const b = f.command("attach", 8, next).then((result) => {
      completed = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect.soft(completed).toBe(false);
    gate.resolve();
    expect.soft(await b).toMatchObject({ type: "result" });
    expect.soft(await f.command("attach", 7, next)).toMatchObject({ type: "result" });
    expect.soft(f.clients.has(oldA)).toBe(false);
  });

  it("retries settled cleanup on explicit acquire without adopting the old client", async () => {
    const f = await fixture();
    const old = await f.attach(7);
    f.h.debuggerDetach.mockRejectedValueOnce(new Error("native cleanup refused"));
    expect(await f.command("detach", 7)).toMatchObject({ type: "error" });
    expect(f.clients.has(old)).toBe(true);
    expect.soft(await f.command("attach", 7)).toMatchObject({ type: "result" });
    expect.soft(f.clients.has(old)).toBe(false);
    expect.soft(f.tabs.get(7)).not.toBe(old);
  });

  it.each(["NoTab", "removal", "replacement"])(
    "retains the actual native client after %s and cleans by owned target identity",
    async (ending) => {
      const f = await fixture();
      const old = await f.attach(7);
      f.tabs.delete(7);
      expect(f.clients.has(old)).toBe(true);
      if (ending === "removal") {
        f.h.tabsRemovedListener?.(7);
      } else if (ending === "replacement") {
        f.h.tabsReplacedListener(10, 7);
      } else {
        expect(await f.command("detach", 7)).toMatchObject({ type: "result" });
      }
      await vi.waitFor(() => expect(f.clients.has(old)).toBe(false));
      expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: old });
    },
  );

  it("does not invent cleanup debt for never-owned removed or replaced tabs", async () => {
    const f = await fixture();
    f.h.tabsRemovedListener?.(50);
    f.h.tabsReplacedListener(52, 51);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(f.h.debuggerDetach).not.toHaveBeenCalled();
    await f.attach(7);
  });

  it("drains an in-flight detach after authoritative native closure before a successor", async () => {
    const f = await fixture();
    const old = await f.attach(7);
    const gate = f.holdDetach(7);
    const detaching = f.command("detach", 7);
    await vi.waitFor(() => expect(f.h.debuggerDetach).toHaveBeenCalled());
    f.clients.delete(old);
    f.h.debuggerDetachListener?.({ tabId: 7 }, "target_closed");
    let attached = false;
    const acquiring = f.command("attach", 7).then((result) => {
      attached = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(attached).toBe(false);
    gate.resolve();
    await detaching;
    expect.soft(await acquiring).toMatchObject({ type: "result" });
    expect.soft(f.clients.size).toBe(1);
    expect.soft(f.clients.has(old)).toBe(false);
  });

  it("uses same-client identity rather than an enumerated attached flag", async () => {
    const f = await fixture();
    f.h.debuggerGetTargets.mockResolvedValue([{ tabId: 7, id: "unrelated", attached: true }]);
    await f.attach(7);
    expect(f.h.debuggerGetTargetInfo).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("rejects missing native identity and cleans its acquired client", async () => {
    const f = await fixture();
    f.h.debuggerGetTargets.mockResolvedValue([]);
    f.h.debuggerGetTargetInfo.mockResolvedValue({ targetInfo: { targetId: "" } });
    expect.soft(await f.command("attach", 7)).toMatchObject({ type: "error" });
    expect.soft(f.clients.size).toBe(0);
  });
  it("retains unknown-identity NoTab debt until authoritative native closure", async () => {
    const f = await fixture();
    f.h.debuggerGetTargets.mockResolvedValue([]);
    f.h.debuggerGetTargetInfo.mockImplementationOnce(async () => {
      f.tabs.delete(7);
      throw new Error("No tab with given id 7.");
    });
    expect(await f.command("attach", 7)).toMatchObject({ type: "error" });
    const old = [...f.clients][0]!;
    expect(f.clients.has(old)).toBe(true);
    expect(await f.command("attach", 7)).toMatchObject({ type: "error" });
    await f.attach(8);
    f.clients.delete(old);
    f.h.debuggerDetachListener?.({ tabId: 7 }, "target_closed");
    await f.attach(7);
    expect(f.clients.size).toBe(2);
  });

  it("captures cleanup identity after native success overtaken by access loss", async () => {
    const f = await fixture();
    const gate = createDeferred<void>();
    releases.push(() => gate.resolve());
    const attach = f.h.debuggerAttach.getMockImplementation()!;
    f.h.debuggerAttach.mockImplementationOnce(async (source) => {
      await attach(source, "1.3");
      await gate.promise;
    });
    const acquiring = f.command("attach", 7);
    await vi.waitFor(() => expect(f.clients.size).toBe(1));
    const old = f.tabs.get(7)!;
    const pausing = sendRuntimeMessage(f.h, {
      type: "toggleTabAccess",
      tabId: 7,
      accessMode: "all",
      grant: false,
    });
    await vi.waitFor(async () =>
      expect(await sendRuntimeMessage(f.h, { type: "getTabAccess", tabId: 7 })).toMatchObject({
        accessible: false,
      }),
    );
    expect(await f.h.tabsGet(7)).toMatchObject({ url: "https://example.com/7" });
    expect(f.h.debuggerGetTargetInfo).not.toHaveBeenCalled();
    gate.resolve();
    expect(await acquiring).toMatchObject({ type: "error" });
    expect(await pausing).toMatchObject({ ok: true, accessible: false, denied: true });
    expect(f.h.debuggerGetTargetInfo).toHaveBeenCalledWith({ tabId: 7 });
    expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: old });
    expect(f.clients.has(old)).toBe(false);
  });

  it("reports incomplete Disconnect and retries its retained native debt", async () => {
    const f = await fixture();
    const old = await f.attach(7);
    const detach = f.h.debuggerDetach.getMockImplementation()!;
    f.h.debuggerDetach.mockRejectedValue(new Error("native cleanup refused"));
    expect(await sendRuntimeMessage(f.h, { type: "unpair" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("native cleanup refused"),
    });
    expect(f.clients.has(old)).toBe(true);
    f.h.debuggerDetach.mockImplementation(detach);
    expect(await sendRuntimeMessage(f.h, { type: "unpair" })).toMatchObject({ ok: true });
    expect(f.clients.has(old)).toBe(false);
  });

  it("fences inherited cleanup enumeration overtaken by re-pair and fresh acquisition", async () => {
    const h = await loadBackground({
      storedConfig: {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: TEST_RELAY_KEY,
        authVersion: 2,
        accessMode: "all",
        copilotSessionRegistryV1: {
          sessions: { 7: { creationPending: true } },
          pendingArchives: [],
        },
      },
    });
    await sendRuntimeMessage(h, { type: "getStatus" });
    const gate = createDeferred<Array<{ tabId: number; id: string; attached: boolean }>>();
    releases.push(() => gate.resolve([]));
    let held = false;
    h.debuggerGetTargets.mockImplementationOnce(async () => {
      held = true;
      return await gate.promise;
    });
    h.storageValues.token = "invalid";
    const status = sendRuntimeMessage(h, { type: "getStatus" });
    await vi.waitFor(() => expect(held).toBe(true));
    expect(await sendRuntimeMessage(h, { type: "unpair" })).toMatchObject({ ok: true });
    expect(
      await sendRuntimeMessage(h, {
        type: "pair",
        pairingString: `ws://127.0.0.1:18797/extension#${TEST_RELAY_KEY}`,
        accessMode: "all",
      }),
    ).toMatchObject({ ok: true });
    const socket = h.relaySockets.at(-1)!;
    await h.authenticate(socket);
    let live = false;
    h.debuggerAttach.mockImplementation(async () => {
      live = true;
    });
    h.debuggerDetach.mockImplementation(async () => {
      live = false;
    });
    h.debuggerGetTargetInfo.mockResolvedValue({ targetInfo: { targetId: "fresh-native" } });
    socket.receive({ type: "attach", tabId: 7, seq: 91 });
    await vi.waitFor(() =>
      expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual({
        type: "result",
        seq: 91,
        result: { targetId: "fresh-native" },
      }),
    );
    gate.resolve([{ tabId: 7, id: "fresh-native", attached: true }]);
    expect(await status).toMatchObject({ ok: false, error: expect.stringContaining("superseded") });
    expect(live).toBe(true);
    expect(h.debuggerDetach).not.toHaveBeenCalled();
  });
});
