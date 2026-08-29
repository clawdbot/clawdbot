import { describe, expect, it, onTestFinished } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  defaultTabs,
  FakeSocket,
  flush,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";

function context(id: number) {
  return {
    id,
    uniqueId: `context-${id}`,
    origin: "https://example.com",
    name: "",
    auxData: { isDefault: true, frameId: "target-1" },
  };
}

function fixture() {
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => bridge.dispose());
  const enabled = new Set<string>();
  const held: number[] = [];
  let hold = false;
  let denyEnable = false;
  let contextOffset = -10;
  const extension = wireExtension(bridge, (msg) => {
    if (msg.type === "ping") {
      return null;
    }
    if (msg.type === "attach") {
      enabled.clear();
      contextOffset += 10;
      return { type: "result", seq: msg.seq, result: { targetId: `target-${msg.tabId}` } };
    }
    if (msg.type === "cdp") {
      const key = msg.sessionId ?? "root";
      if (msg.method === "Runtime.enable") {
        if (denyEnable) {
          return { type: "error", seq: msg.seq, message: "tab 1 access was revoked" };
        }
        // V8 reports existing contexts only on the physical disabled -> enabled transition.
        if (!enabled.has(key)) {
          enabled.add(key);
          event(
            "Runtime.executionContextCreated",
            { context: context(key === "root" ? 1 + contextOffset : 2) },
            msg.sessionId,
          );
        }
        if (hold) {
          held.push(msg.seq);
          return null;
        }
      }
      if (msg.method === "Runtime.disable") {
        enabled.delete(key);
      }
    }
    return { type: "result", seq: msg.seq, result: {} };
  });
  function event(method: string, params: unknown, sessionId?: string) {
    extension.handlers.onMessage(
      JSON.stringify({ type: "cdpEvent", tabId: 1, sessionId, method, params }),
    );
  }
  sendHello(extension.handlers);
  function client() {
    const socket = new FakeSocket();
    const handlers = bridge.attachCdpClientSocket(socket);
    let nextId = 1;
    function send(method: string, sessionId?: string, params?: Record<string, unknown>) {
      const id = nextId++;
      handlers.onMessage(JSON.stringify({ id, method, sessionId, params }));
      return id;
    }
    async function request(method: string, sessionId?: string, params?: Record<string, unknown>) {
      const id = send(method, sessionId, params);
      await flush();
      const response = socket.frames().find((frame) => frame.id === id);
      expect(response, method).toBeDefined();
      return response!;
    }
    async function attach() {
      const response = await request("Target.setAutoAttach", undefined, { autoAttach: true });
      expect(response.error).toBeUndefined();
      const announcement = socket
        .frames()
        .findLast((frame) => frame.method === "Target.attachedToTarget");
      if (!announcement) {
        throw new Error("Missing Target.attachedToTarget announcement");
      }
      const { sessionId } = announcement.params as { sessionId: string };
      return sessionId;
    }
    return { socket, handlers, send, request, attach };
  }
  function commands(method: string) {
    return extension.socket.frames().filter((frame) => frame.method === method);
  }
  return {
    bridge,
    extension,
    event,
    client,
    commands,
    denyEnable: () => {
      denyEnable = true;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const seq of held.splice(0)) {
        extension.handlers.onMessage(JSON.stringify({ type: "result", seq, result: {} }));
      }
    },
  };
}

function created(socket: FakeSocket, sessionId: string) {
  return socket
    .frames()
    .filter(
      (frame) =>
        frame.sessionId === sessionId && frame.method === "Runtime.executionContextCreated",
    );
}

function expectContextBeforeResult(
  socket: FakeSocket,
  sessionId: string,
  id: unknown,
  contexts = [context(1)],
) {
  const frames = socket.frames();
  const resultIndex = frames.findIndex((frame) => frame.id === id);
  expect(resultIndex).toBeGreaterThanOrEqual(0);
  expect(created(socket, sessionId).map((frame) => frame.params)).toEqual(
    contexts.map((value) => ({ context: value })),
  );
  for (const frame of created(socket, sessionId)) {
    expect(frames.indexOf(frame)).toBeLessThan(resultIndex);
  }
}

describe("relay logical Runtime subscriptions", () => {
  it("does not replay cached contexts when current native admission rejects a late enable", async () => {
    const f = fixture();
    const first = f.client();
    const root = await first.attach();
    await first.request("Runtime.enable", root);
    const late = f.client();
    const lateRoot = await late.attach();
    // The worker has revoked access, but its tabs/detach notification has not
    // reached the relay. Native admission must still precede cached replay.
    f.denyEnable();
    const response = await late.request("Runtime.enable", lateRoot);
    expect(response.error).toMatchObject({ message: "tab 1 access was revoked" });
    expect(created(late.socket, lateRoot)).toEqual([]);
    expect(created(first.socket, root)).toHaveLength(1);
  });

  it("delivers the live default context to a late client before enable completes without replaying to established clients", async () => {
    const f = fixture();
    const first = f.client();
    const root = await first.attach();
    const firstEnable = await first.request("Runtime.enable", root);
    expectContextBeforeResult(first.socket, root, firstEnable.id);
    const late = f.client();
    const lateRoot = await late.attach();
    expect(created(late.socket, lateRoot)).toEqual([]);
    const lateEnable = await late.request("Runtime.enable", lateRoot);
    expectContextBeforeResult(late.socket, lateRoot, lateEnable.id);
    await first.request("Runtime.enable", root);
    expect(created(first.socket, root)).toHaveLength(1);
    expect(f.commands("Runtime.enable")).toHaveLength(3);
  });

  it.each(["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"])(
    "never replays retired contexts after %s",
    async (method) => {
      const f = fixture();
      const first = f.client();
      const root = await first.attach();
      await first.request("Runtime.enable", root);
      f.event(method, { executionContextId: 1, executionContextUniqueId: "context-1" });
      f.event("Runtime.executionContextCreated", { context: context(3) });
      const late = f.client();
      const lateRoot = await late.attach();
      const response = await late.request("Runtime.enable", lateRoot);
      expectContextBeforeResult(late.socket, lateRoot, response.id, [context(3)]);
      expect(first.socket.frames()).toContainEqual({
        method,
        sessionId: root,
        params: { executionContextId: 1, executionContextUniqueId: "context-1" },
      });
    },
  );

  it("validates concurrent enables and delivers each context once to subscribers", async () => {
    const f = fixture();
    const first = f.client();
    const second = f.client();
    const root = await first.attach();
    const secondRoot = await second.attach();
    f.hold();
    const a = first.send("Runtime.enable", root);
    const b = second.send("Runtime.enable", secondRoot);
    const repeated = first.send("Runtime.enable", root);
    await flush();
    expect(first.socket.frames().find((frame) => frame.id === a)).toBeUndefined();
    expect(second.socket.frames().find((frame) => frame.id === b)).toBeUndefined();
    expect(f.commands("Runtime.enable")).toHaveLength(3);
    f.release();
    await flush();
    expectContextBeforeResult(first.socket, root, a);
    expectContextBeforeResult(second.socket, secondRoot, b);
    expect(first.socket.frames().find((frame) => frame.id === repeated)).toMatchObject({
      result: {},
    });
  });

  it.each(["Runtime.disable", "Target.detachFromTarget", "socket close"])(
    "keeps the other client's Runtime alive after %s",
    async (operation) => {
      const f = fixture();
      const first = f.client();
      const second = f.client();
      const root = await first.attach();
      const secondRoot = await second.attach();
      await first.request("Runtime.enable", root);
      await second.request("Runtime.enable", secondRoot);
      if (operation === "socket close") {
        first.handlers.onClose();
      } else if (operation === "Runtime.disable") {
        await first.request(operation, root);
      } else {
        await first.request(operation, undefined, { sessionId: root });
      }
      const before = first.socket.frames().length;
      f.event("Runtime.executionContextCreated", { context: context(3) });
      expect(first.socket.frames()).toHaveLength(before);
      expect(created(second.socket, secondRoot).at(-1)?.params).toEqual({ context: context(3) });
      expect(f.commands("Runtime.disable")).toEqual([]);
      expect(f.extension.socket.frames().filter((frame) => frame.type === "detach")).toEqual([]);
      expect(
        (
          await second.request("DOM.resolveNode", secondRoot, {
            backendNodeId: 17,
            executionContextId: 1,
          })
        ).error,
      ).toBeUndefined();
    },
  );

  it.each([false, true])(
    "gives explicit page attachments independent subscriptions (browser parent=%s)",
    async (browserParent) => {
      const f = fixture();
      const c = f.client();
      const root = await c.attach();
      await c.request("Runtime.enable", root);
      const parent = browserParent
        ? ((await c.request("Target.attachToBrowserTarget")).result as { sessionId: string })
            .sessionId
        : undefined;
      const response = await c.request("Target.attachToTarget", parent, {
        targetId: "target-1",
        flatten: true,
      });
      const alias = (response.result as { sessionId: string }).sessionId;
      expect(alias).not.toBe(root);
      expect(c.socket.frames()).toContainEqual({
        ...(parent ? { sessionId: parent } : {}),
        method: "Target.attachedToTarget",
        params: {
          sessionId: alias,
          targetInfo: expect.objectContaining({ targetId: "target-1" }),
          waitingForDebugger: false,
        },
      });
      expect(created(c.socket, alias)).toEqual([]);
      const enabled = await c.request("Runtime.enable", alias);
      expectContextBeforeResult(c.socket, alias, enabled.id);
      await c.request("Runtime.disable", alias);
      f.event("Runtime.consoleAPICalled", { type: "log", args: [] });
      expect(
        c.socket
          .frames()
          .filter((frame) => frame.method === "Runtime.consoleAPICalled")
          .map((frame) => frame.sessionId),
      ).toEqual([root]);
      await c.request("Target.detachFromTarget", parent, { sessionId: alias });
      expect((await c.request("Runtime.enable", alias)).error).toBeDefined();
      expect(f.commands("Runtime.enable")).toHaveLength(2);
    },
  );

  it("routes real child contexts separately and retires child routing on detach, including pending enables", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Runtime.enable", root);
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { type: "iframe", targetId: "frame" },
      waitingForDebugger: false,
    });
    f.hold();
    const pending = c.send("Runtime.enable", "child");
    await flush();
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
    f.event("Runtime.executionContextCreated", { context: context(4) }, "child");
    f.release();
    await flush();
    expect(c.socket.frames().find((frame) => frame.id === pending)?.error).toBeDefined();
    expect(created(c.socket, root).map((frame) => frame.params)).toEqual([{ context: context(1) }]);
    expect(
      created(c.socket, "child").some(
        (frame) => (frame.params as { context: { id: number } }).context.id === 4,
      ),
    ).toBe(false);
    expect((await c.request("Runtime.enable", "child")).error).toBeDefined();
    expect(f.commands("Runtime.enable")).toHaveLength(2);
  });

  it.each([false, true])(
    "keeps child Runtime subscriptions independent and routes detach to their parent (alias only=%s)",
    async (aliasOnly) => {
      const f = fixture();
      const first = f.client();
      const root = await first.attach();
      const second = f.client();
      const secondRoot = aliasOnly
        ? (
            (
              await second.request("Target.attachToTarget", undefined, {
                targetId: "target-1",
                flatten: true,
              })
            ).result as { sessionId: string }
          ).sessionId
        : await second.attach();
      f.event("Target.attachedToTarget", {
        sessionId: "child",
        targetInfo: { type: "iframe", targetId: "frame" },
        waitingForDebugger: false,
      });
      expect(second.socket.frames()).toContainEqual({
        sessionId: secondRoot,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child",
          targetInfo: { type: "iframe", targetId: "frame" },
          waitingForDebugger: false,
        },
      });
      await first.request("Runtime.enable", "child");
      const response = await second.request("Runtime.enable", "child");
      expectContextBeforeResult(second.socket, "child", response.id, [context(2)]);
      expect(created(first.socket, "child")).toHaveLength(1);
      await first.request("Target.detachFromTarget", root, { sessionId: "child" });
      expect(first.socket.frames()).toContainEqual({
        sessionId: root,
        method: "Target.detachedFromTarget",
        params: { sessionId: "child" },
      });
      f.event("Runtime.executionContextCreated", { context: context(4) }, "child");
      expect(created(first.socket, "child")).toHaveLength(1);
      expect(created(second.socket, "child").at(-1)?.params).toEqual({ context: context(4) });
      f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
      expect(second.socket.frames()).toContainEqual({
        sessionId: secondRoot,
        method: "Target.detachedFromTarget",
        params: { sessionId: "child", targetId: "frame" },
      });
      expect((await second.request("Runtime.enable", "child")).error).toBeDefined();
      expect(f.commands("Target.detachFromTarget")).toEqual([]);
    },
  );

  it("does not announce an attachment or forward queued commands after the last client closes", async () => {
    const bridge = new ExtensionRelayBridge();
    onTestFinished(() => bridge.dispose());
    const extension = new FakeSocket();
    const ext = bridge.attachExtensionSocket(extension);
    sendHello(ext);
    const socket = new FakeSocket();
    const client = bridge.attachCdpClientSocket(socket);
    client.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    const attach = extension.frames().find((frame) => frame.type === "attach");
    expect(attach).toBeDefined();
    client.onClose();
    ext.onMessage(
      JSON.stringify({ type: "result", seq: attach!.seq, result: { targetId: "target-1" } }),
    );
    await flush();
    client.onMessage(
      JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    expect(socket.frames()).toEqual([]);
    expect(extension.frames().filter((frame) => frame.type === "detach")).toHaveLength(1);
  });

  it("rejects unannounced and foreign root, alias, browser and child sessions without forwarding", async () => {
    const f = fixture();
    const owner = f.client();
    const root = await owner.attach();
    const browser = (
      (await owner.request("Target.attachToBrowserTarget")).result as { sessionId: string }
    ).sessionId;
    const alias = (
      (
        await owner.request("Target.attachToTarget", browser, {
          targetId: "target-1",
          flatten: true,
        })
      ).result as { sessionId: string }
    ).sessionId;
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { type: "worker", targetId: "worker" },
    });
    const foreign = f.client();
    for (const session of [root, alias, browser, "child", "missing"]) {
      expect((await foreign.request("Runtime.evaluate", session)).error).toBeDefined();
      expect(
        (await foreign.request("Target.detachFromTarget", undefined, { sessionId: session })).error,
      ).toBeDefined();
    }
    expect(f.commands("Runtime.evaluate")).toEqual([]);
    expect((await owner.request("Runtime.evaluate", root)).error).toBeUndefined();
  });

  it("does not resume a disabled or closed client's pending enable or accept messages after close", async () => {
    const f = fixture();
    const closed = f.client();
    const live = f.client();
    const root = await closed.attach();
    const liveRoot = await live.attach();
    f.hold();
    closed.send("Runtime.enable", root);
    const pending = live.send("Runtime.enable", liveRoot);
    await flush();
    closed.handlers.onClose();
    await live.request("Runtime.disable", liveRoot);
    const before = closed.socket.frames().length;
    closed.send("Runtime.evaluate", root);
    f.release();
    await flush();
    expect(closed.socket.frames()).toHaveLength(before);
    expect(f.commands("Runtime.evaluate")).toEqual([]);
    expect(live.socket.frames().find((frame) => frame.id === pending)?.error).toBeDefined();
    const eventsBefore = created(live.socket, liveRoot).length;
    f.event("Runtime.executionContextCreated", { context: context(3) });
    expect(created(live.socket, liveRoot)).toHaveLength(eventsBefore);
    await live.request("Runtime.enable", liveRoot);
    expect(
      created(live.socket, liveRoot)
        .slice(eventsBefore)
        .map((frame) => frame.params),
    ).toEqual([{ context: context(1) }, { context: context(3) }]);
  });

  it.each(["revoke", "detach", "replacement", "loss", "shutdown"])(
    "retires context inventory and pending work on %s",
    async (kind) => {
      const f = fixture();
      const c = f.client();
      const root = await c.attach();
      f.hold();
      const pending = c.send("Runtime.enable", root);
      await flush();
      if (kind === "revoke") {
        f.extension.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
      }
      if (kind === "detach") {
        f.extension.handlers.onMessage(
          JSON.stringify({ type: "detached", tabId: 1, reason: "revoked" }),
        );
      }
      if (kind === "replacement") {
        sendHello(wireExtension(f.bridge).handlers);
      }
      if (kind === "loss") {
        f.extension.handlers.onClose();
      }
      if (kind === "shutdown") {
        f.bridge.dispose();
      }
      const before = c.socket.frames().length;
      f.event("Runtime.executionContextCreated", { context: context(9) });
      f.release();
      await flush();
      if (kind === "shutdown") {
        expect(c.socket.frames()).toHaveLength(before);
        return;
      }
      expect(c.socket.frames().find((frame) => frame.id === pending)?.error).toBeDefined();
      expect(
        created(c.socket, root).some(
          (frame) => (frame.params as { context: { id: number } }).context.id === 9,
        ),
      ).toBe(false);
      if (kind === "revoke") {
        f.extension.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: defaultTabs() }));
      }
      if (kind === "loss") {
        sendHello(wireExtension(f.bridge).handlers);
      }
      const next = await c.attach();
      expect(next).not.toBe(root);
      await c.request("Runtime.enable", next);
      expect(created(c.socket, next).map((frame) => frame.params)).toEqual(
        kind === "revoke" || kind === "detach" ? [{ context: context(11) }] : [],
      );
    },
  );
});
