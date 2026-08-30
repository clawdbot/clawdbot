import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  let heldMethod: string | undefined;
  let accessAllowed = true;
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
        if (!accessAllowed) {
          return { type: "error", seq: msg.seq, message: "tab access was revoked" };
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
      }
      if (msg.method === "Runtime.disable") {
        enabled.delete(key);
      }
      if (msg.method === heldMethod) {
        held.push(msg.seq);
        return null;
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
    async function autoAttach(parent: string) {
      expect(
        (
          await request("Target.setAutoAttach", parent, {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
          })
        ).error,
      ).toBeUndefined();
    }
    function child(targetId: string, parent?: string) {
      const announcement = socket
        .frames()
        .findLast(
          (frame) =>
            frame.method === "Target.attachedToTarget" &&
            (parent === undefined || frame.sessionId === parent) &&
            asOptionalRecord(asOptionalRecord(frame.params)?.targetInfo)?.targetId === targetId,
        );
      const id = asOptionalRecord(announcement?.params)?.sessionId;
      if (typeof id !== "string") {
        throw new Error("Missing logical child announcement");
      }
      return id;
    }
    return { socket, handlers, send, request, attach, autoAttach, child };
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
    revokeAccess: () => {
      accessAllowed = false;
    },
    hold: (method = "Runtime.enable") => {
      heldMethod = method;
    },
    release: () => {
      heldMethod = undefined;
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

  it("admits each concurrent enable and delivers each context once to new subscribers", async () => {
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
      expect(c.socket.frames()).toContainEqual({
        ...(parent ? { sessionId: parent } : {}),
        method: "Target.detachedFromTarget",
        params: { sessionId: alias, targetId: "target-1" },
      });
      expect((await c.request("Runtime.enable", alias)).error).toBeDefined();
      expect(f.commands("Runtime.enable")).toHaveLength(2);
    },
  );

  it("routes real child contexts separately and retires child routing on detach, including pending enables", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Runtime.enable", root);
    await c.autoAttach(root);
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { type: "iframe", targetId: "frame" },
      waitingForDebugger: false,
    });
    const child = c.child("frame", root);
    f.hold();
    const pending = c.send("Runtime.enable", child);
    await flush();
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
    f.event("Runtime.executionContextCreated", { context: context(4) }, "child");
    f.release();
    await flush();
    expect(c.socket.frames().find((frame) => frame.id === pending)?.error).toBeDefined();
    expect(created(c.socket, root).map((frame) => frame.params)).toEqual([{ context: context(1) }]);
    expect(
      created(c.socket, child).some(
        (frame) => (frame.params as { context: { id: number } }).context.id === 4,
      ),
    ).toBe(false);
    expect((await c.request("Runtime.enable", child)).error).toBeDefined();
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
      await first.autoAttach(root);
      await second.autoAttach(secondRoot);
      f.event("Target.attachedToTarget", {
        sessionId: "child",
        targetInfo: { type: "iframe", targetId: "frame" },
        waitingForDebugger: false,
      });
      const firstChild = first.child("frame", root);
      const secondChild = second.child("frame", secondRoot);
      expect(firstChild).not.toBe(secondChild);
      expect(second.socket.frames()).toContainEqual({
        sessionId: secondRoot,
        method: "Target.attachedToTarget",
        params: {
          sessionId: secondChild,
          targetInfo: { type: "iframe", targetId: "frame" },
          waitingForDebugger: false,
        },
      });
      await first.request("Runtime.enable", firstChild);
      const response = await second.request("Runtime.enable", secondChild);
      expectContextBeforeResult(second.socket, secondChild, response.id, [context(2)]);
      expect(created(first.socket, firstChild)).toHaveLength(1);
      await first.request("Target.detachFromTarget", root, { sessionId: firstChild });
      expect(first.socket.frames()).toContainEqual({
        sessionId: root,
        method: "Target.detachedFromTarget",
        params: { sessionId: firstChild, targetId: "frame" },
      });
      f.event("Runtime.executionContextCreated", { context: context(4) }, "child");
      expect(created(first.socket, firstChild)).toHaveLength(1);
      expect(created(second.socket, secondChild).at(-1)?.params).toEqual({ context: context(4) });
      f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
      expect(second.socket.frames()).toContainEqual({
        sessionId: secondRoot,
        method: "Target.detachedFromTarget",
        params: { sessionId: secondChild, targetId: "frame" },
      });
      expect((await second.request("Runtime.enable", secondChild)).error).toBeDefined();
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
    await owner.autoAttach(root);
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { type: "worker", targetId: "worker" },
    });
    const child = owner.child("worker", root);
    const foreign = f.client();
    for (const session of [root, alias, browser, child, "missing"]) {
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

  it.each([
    "extension loss",
    "extension replacement",
    "native detach",
    "access loss",
    "bridge disposal",
  ])("retires every logical target identity on %s", async (ending) => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    const browser = asOptionalRecord(
      (await c.request("Target.attachToBrowserTarget")).result,
    )?.sessionId;
    if (typeof browser !== "string") {
      throw new Error("Missing browser session");
    }
    const alias = asOptionalRecord(
      (await c.request("Target.attachToTarget", browser, { targetId: "target-1" })).result,
    )?.sessionId;
    expect(typeof alias).toBe("string");
    await c.autoAttach(root);
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { targetId: "frame", type: "iframe" },
      waitingForDebugger: false,
    });
    const child = c.child("frame", root);
    await c.autoAttach(child);
    f.event(
      "Target.attachedToTarget",
      {
        sessionId: "grandchild",
        targetInfo: { targetId: "worker", type: "worker" },
        waitingForDebugger: false,
      },
      "child",
    );
    const grandchild = c.child("worker", child);
    if (ending === "extension loss") {
      f.extension.handlers.onClose();
    }
    if (ending === "extension replacement") {
      sendHello(wireExtension(f.bridge).handlers);
    }
    if (ending === "native detach") {
      f.extension.handlers.onMessage(
        JSON.stringify({ type: "detached", tabId: 1, reason: "target_closed" }),
      );
    }
    if (ending === "access loss") {
      f.extension.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    }
    if (ending === "bridge disposal") {
      c.socket.send = (data) => {
        expect(c.socket.closed).toBe(false);
        FakeSocket.prototype.send.call(c.socket, data);
      };
      f.bridge.dispose();
    }
    const detached = c.socket
      .frames()
      .filter((frame) => frame.method === "Target.detachedFromTarget");
    expect(detached.map((frame) => frame.params)).toEqual(
      expect.arrayContaining([
        { sessionId: root, targetId: "target-1" },
        { sessionId: alias, targetId: "target-1" },
        { sessionId: child, targetId: "frame" },
        { sessionId: grandchild, targetId: "worker" },
      ]),
    );
    expect(detached).toHaveLength(4);
    expect(
      detached.find((frame) => asOptionalRecord(frame.params)?.sessionId === alias)?.sessionId,
    ).toBe(browser);
    if (ending === "native detach") {
      expect(f.bridge.devtoolsTargetDescriptors()).toEqual([
        expect.objectContaining({ id: "target-1" }),
      ]);
      const next = await c.attach();
      expect(next).not.toBe(root);
      expect((await c.request("Runtime.enable", next)).error).toBeUndefined();
    }
    if (ending === "extension loss") {
      expect(f.bridge.devtoolsTargetDescriptors()).toEqual([
        expect.objectContaining({ id: "tab-1" }),
      ]);
      sendHello(wireExtension(f.bridge).handlers);
      const next = await c.attach();
      expect(next).not.toBe(root);
      expect((await c.request("Runtime.enable", root)).error).toBeDefined();
    }
  });

  it.each([undefined, "unrelated-target"])(
    "uses owned child identities when detach carries %s",
    async (targetId) => {
      const f = fixture();
      const c = f.client();
      const root = await c.attach();
      await c.request("Runtime.enable", root);
      await c.autoAttach(root);
      f.event("Target.attachedToTarget", {
        sessionId: "child",
        targetInfo: { targetId: "frame", type: "iframe" },
        waitingForDebugger: false,
      });
      const child = c.child("frame", root);
      await c.autoAttach(child);
      f.event(
        "Target.attachedToTarget",
        {
          sessionId: "grandchild",
          targetInfo: { targetId: "worker", type: "worker" },
          waitingForDebugger: false,
        },
        "child",
      );
      const grandchild = c.child("worker", child);
      f.event("Target.detachedFromTarget", { sessionId: "child", targetId });
      expect(
        c.socket
          .frames()
          .filter((frame) => frame.method === "Target.detachedFromTarget")
          .map((frame) => frame.params),
      ).toEqual([
        { sessionId: child, targetId: "frame" },
        { sessionId: grandchild, targetId: "worker" },
      ]);
      expect((await c.request("Page.getFrameTree", root)).error).toBeUndefined();
      expect(f.extension.socket.frames().filter((frame) => frame.type === "detach")).toEqual([]);
      expect(created(c.socket, root)).toHaveLength(1);
    },
  );

  it("requires current worker admission before replaying a cached Runtime to a new logical owner", async () => {
    const f = fixture();
    const first = f.client();
    const root = await first.attach();
    await first.request("Runtime.enable", root);
    const late = f.client();
    const lateRoot = await late.attach();
    // The worker has observed access loss before its tab-list update reaches the relay.
    f.revokeAccess();
    const denied = await late.request("Runtime.enable", lateRoot);
    expect.soft(denied.error).toMatchObject({ message: "tab access was revoked" });
    expect.soft(created(late.socket, lateRoot)).toEqual([]);
    expect(created(first.socket, root)).toHaveLength(1);
    expect(f.commands("Runtime.enable")).toHaveLength(2);
    expect(first.socket.closed).toBe(false);
    expect(late.socket.closed).toBe(false);
    expect(f.commands("Runtime.disable")).toEqual([]);
  });

  it("delivers live events during admission and replays only undelivered current contexts after success", async () => {
    const f = fixture();
    const first = f.client();
    const root = await first.attach();
    await first.request("Runtime.enable", root);
    f.event("Runtime.executionContextCreated", { context: context(2) });
    const late = f.client();
    const lateRoot = await late.attach();
    f.hold();
    const pending = late.send("Runtime.enable", lateRoot);
    await flush();
    expect.soft(created(late.socket, lateRoot)).toEqual([]);
    expect.soft(late.socket.frames().find((frame) => frame.id === pending)).toBeUndefined();
    f.event("Runtime.executionContextCreated", { context: context(3) });
    f.event("Runtime.consoleAPICalled", { type: "log", args: [] });
    f.event("Runtime.executionContextDestroyed", { executionContextId: 1 });
    expect
      .soft(created(late.socket, lateRoot).map((frame) => frame.params))
      .toEqual([{ context: context(3) }]);
    expect(late.socket.frames()).toContainEqual({
      sessionId: lateRoot,
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [] },
    });
    f.release();
    await flush();
    expectContextBeforeResult(late.socket, lateRoot, pending, [context(3), context(2)]);
    expect(created(first.socket, root)).toHaveLength(3);
  });

  it.each([false, true])(
    "preserves native binding callbacks independently of Runtime enable (disabled=%s)",
    async (disabled) => {
      const f = fixture();
      const client = f.client();
      const root = await client.attach();
      const peer = f.client();
      const peerRoot = await peer.attach();
      await peer.request("Runtime.enable", peerRoot);
      expect(
        (await client.request("Runtime.addBinding", root, { name: "relayBinding" })).error,
      ).toBeUndefined();
      if (disabled) {
        await client.request("Runtime.enable", root);
        await client.request("Runtime.disable", root);
      }
      const params = { name: "relayBinding", payload: "callback", executionContextId: 1 };
      f.event("Runtime.bindingCalled", params);
      expect(client.socket.frames()).toContainEqual({
        sessionId: root,
        method: "Runtime.bindingCalled",
        params,
      });
      expect(
        peer.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toEqual([]);
      await client.request("Target.detachFromTarget", undefined, { sessionId: root });
      const before = client.socket.frames().length;
      f.event("Runtime.bindingCalled", params);
      expect(client.socket.frames()).toHaveLength(before);
    },
  );

  it.each(["Runtime.removeBinding", "Target.detachFromTarget", "socket close"])(
    "preserves a peer's same-name binding after %s and removes the final native registration",
    async (operation) => {
      const f = fixture();
      const first = f.client();
      const firstRoot = await first.attach();
      const second = f.client();
      const secondRoot = await second.attach();
      const observer = f.client();
      const observerRoot = await observer.attach();
      const name = "sharedBinding";
      for (const [client, root] of [
        [first, firstRoot],
        [second, secondRoot],
      ] as const) {
        expect((await client.request("Runtime.addBinding", root, { name })).error).toBeUndefined();
      }
      await observer.request("Runtime.removeBinding", observerRoot, { name });
      expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
      if (operation === "socket close") {
        first.handlers.onClose();
        await flush();
      } else if (operation === "Target.detachFromTarget") {
        await first.request(operation, undefined, { sessionId: firstRoot });
      } else {
        await first.request(operation, firstRoot, { name });
      }
      expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
      const params = { name, payload: "still-owned", executionContextId: 1 };
      f.event("Runtime.bindingCalled", params);
      expect(
        first.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toEqual([]);
      expect(
        observer.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toEqual([]);
      expect(
        second.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toEqual([{ sessionId: secondRoot, method: "Runtime.bindingCalled", params }]);
      await second.request("Runtime.removeBinding", secondRoot, { name });
      expect(f.commands("Runtime.removeBinding").map((frame) => frame.params)).toEqual([{ name }]);
      f.event("Runtime.bindingCalled", params);
      expect(
        second.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "cleans up a native add admitted after logical close (peer owns same name=%s)",
    async (sameName) => {
      const f = fixture();
      const first = f.client();
      const firstRoot = await first.attach();
      const second = f.client();
      const secondRoot = await second.attach();
      const name = "pendingBinding";
      if (sameName) {
        await second.request("Runtime.addBinding", secondRoot, { name });
      }
      f.hold("Runtime.addBinding");
      const pending = first.send("Runtime.addBinding", firstRoot, { name });
      await flush();
      first.handlers.onClose();
      f.release();
      await flush();
      expect(first.socket.frames().find((frame) => frame.id === pending)).toBeUndefined();
      expect(f.commands("Runtime.removeBinding")).toHaveLength(sameName ? 0 : 1);
      const params = { name, payload: "after-close", executionContextId: 1 };
      f.event("Runtime.bindingCalled", params);
      expect(
        first.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toEqual([]);
      expect(
        second.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toHaveLength(sameName ? 1 : 0);
    },
  );

  it.each(["Runtime.addBinding", "Runtime.removeBinding"])(
    "preserves acknowledged binding ownership when native %s fails",
    async (method) => {
      const f = fixture();
      const client = f.client();
      const root = await client.attach();
      const name = "failedBinding";
      if (method === "Runtime.removeBinding") {
        await client.request("Runtime.addBinding", root, { name });
      }
      f.hold(method);
      const pending = client.send(method, root, { name });
      await flush();
      f.extension.handlers.onMessage(
        JSON.stringify({
          type: "error",
          seq: f.commands(method).at(-1)!.seq,
          message: "native binding command failed",
        }),
      );
      await flush();
      expect(client.socket.frames().find((frame) => frame.id === pending)?.error).toBeDefined();
      f.release();
      f.event("Runtime.bindingCalled", { name, payload: "failure", executionContextId: 1 });
      expect(
        client.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toHaveLength(method === "Runtime.removeBinding" ? 1 : 0);
      expect((await client.request(method, root, { name })).error).toBeUndefined();
      f.event("Runtime.bindingCalled", { name, payload: "retry", executionContextId: 1 });
      expect(
        client.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
      ).toHaveLength(1);
    },
  );

  it("keeps a replacement physical session independent of pending retired bindings", async () => {
    const f = fixture();
    const client = f.client();
    const root = await client.attach();
    const name = "retiredBinding";
    f.hold("Runtime.addBinding");
    client.send("Runtime.addBinding", root, { name });
    await flush();
    f.extension.handlers.onMessage(
      JSON.stringify({ type: "detached", tabId: 1, reason: "revoked" }),
    );
    f.release();
    await flush();
    const next = await client.attach();
    expect(next).not.toBe(root);
    const params = { name, payload: "replacement", executionContextId: 11 };
    f.event("Runtime.bindingCalled", params);
    expect(
      client.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
    ).toEqual([]);
    await client.request("Runtime.addBinding", next, { name });
    f.event("Runtime.bindingCalled", params);
    expect(
      client.socket.frames().filter((frame) => frame.method === "Runtime.bindingCalled"),
    ).toEqual([{ sessionId: next, method: "Runtime.bindingCalled", params }]);
    expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
  });

  it("keeps a concurrent admission alive when another enable for the same logical owner fails", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    f.hold();
    const failed = c.send("Runtime.enable", root);
    const admitted = c.send("Runtime.enable", root);
    await flush();
    f.extension.handlers.onMessage(
      JSON.stringify({
        type: "error",
        seq: f.commands("Runtime.enable")[0]!.seq,
        message: "admission failed",
      }),
    );
    await flush();
    expect(c.socket.frames().find((frame) => frame.id === failed)?.error).toBeDefined();
    expect.soft(c.socket.frames().find((frame) => frame.id === admitted)).toBeUndefined();
    f.release();
    await flush();
    expect(c.socket.frames().find((frame) => frame.id === admitted)).toMatchObject({ result: {} });
    expectContextBeforeResult(c.socket, root, admitted);
    f.event("Runtime.executionContextCreated", { context: context(3) });
    expect(created(c.socket, root)).toHaveLength(2);
    expect(f.commands("Runtime.disable")).toEqual([]);
  });
});
