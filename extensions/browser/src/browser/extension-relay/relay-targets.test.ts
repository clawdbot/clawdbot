import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  FakeSocket,
  flush,
  replyFor,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";
import type { RelayCommandBody } from "./relay-protocol.js";

const enabled = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
function fixture() {
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => bridge.dispose());
  let hold: string | undefined;
  let failure: string | undefined;
  let targetId: string | undefined = "target-1";
  const held: Array<RelayCommandBody & { seq: number }> = [];
  const extension = wireExtension(bridge, (message) => {
    if (message.type === "ping") {
      return replyFor(message);
    }
    if (message.type === hold || (message.type === "cdp" && message.method === hold)) {
      held.push(message);
      return null;
    }
    if (message.type === failure || (message.type === "cdp" && message.method === failure)) {
      failure = undefined;
      return {
        type: "error",
        seq: message.seq,
        message: "native transition failed after dispatch",
      };
    }
    if (message.type === "attach") {
      return { type: "result", seq: message.seq, result: targetId ? { targetId } : {} };
    }
    return replyFor(message);
  });
  sendHello(extension.handlers);
  const event = (method: string, params: unknown, sessionId?: string) =>
    extension.handlers.onMessage(
      JSON.stringify({ type: "cdpEvent", tabId: 1, method, params, sessionId }),
    );
  const child = (id: string, parent?: string, type = "worker") =>
    event(
      "Target.attachedToTarget",
      {
        sessionId: id,
        targetInfo: { targetId: `target-${id}`, type, url: "https://example.com/child" },
        waitingForDebugger: true,
      },
      parent,
    );
  const commands = (method: string) =>
    extension.socket
      .frames()
      .filter((f) => f.type === method || (f.type === "cdp" && f.method === method));
  const client = () => {
    const socket = new FakeSocket();
    const handlers = bridge.attachCdpClientSocket(socket);
    let nextRequest = 0;
    const send = (method: string, sessionId?: string, params?: Record<string, unknown>) => {
      const next = ++nextRequest;
      handlers.onMessage(JSON.stringify({ id: next, method, sessionId, params }));
      return next;
    };
    const response = async (id: number) =>
      await vi.waitFor(() => {
        const frame = socket.frames().find((f) => f.id === id);
        expect(frame).toBeDefined();
        return frame!;
      });
    const request = async (method: string, sessionId?: string, params?: Record<string, unknown>) =>
      await response(send(method, sessionId, params));
    const attached = (parent?: string) =>
      socket
        .frames()
        .filter((f) => f.method === "Target.attachedToTarget" && f.sessionId === parent)
        .map((f) => asOptionalRecord(f.params)!);
    const attach = async () => {
      await request("Target.setAutoAttach", undefined, enabled);
      const id = attached().at(-1)?.sessionId;
      if (typeof id !== "string") {
        throw new Error("Root attachment missing");
      }
      return id;
    };
    const alias = async () => {
      const result = await request("Target.attachToTarget", undefined, {
        targetId: "target-1",
        flatten: true,
      });
      const id = asOptionalRecord(result.result)?.sessionId;
      if (typeof id !== "string") {
        throw new Error("Logical attachment missing");
      }
      return id;
    };
    return { socket, send, response, request, attached, attach, alias, close: handlers.onClose };
  };
  return {
    bridge,
    extension,
    event,
    child,
    commands,
    client,
    hold: (method?: string) => {
      hold = method;
    },
    fail: (method: string) => {
      failure = method;
    },
    target: (id?: string) => {
      targetId = id;
    },
    held,
    release: () => {
      hold = undefined;
      for (const message of held.splice(0)) {
        extension.handlers.onMessage(
          JSON.stringify({
            type: "result",
            seq: message.seq,
            result: message.type === "attach" ? (targetId ? { targetId } : {}) : {},
          }),
        );
      }
    },
  };
}
function childId(c: ReturnType<ReturnType<typeof fixture>["client"]>, parent: string) {
  const id = c.attached(parent).at(-1)?.sessionId;
  expect(typeof id).toBe("string");
  return String(id);
}

describe("pending tab acquisition claims", () => {
  it.each(["unrelated", "pending peer", "delivered peer"])(
    "releases only an abandoned acquisition with %s remaining",
    async (peer) => {
      const f = fixture();
      const first = f.client();
      await first.attach();
      const other = f.client();
      await first.close();
      await flush();
      const before = f.commands("detach").length;
      if (peer === "delivered peer") {
        await other.attach();
      }
      f.hold("attach");
      const lost = f.client();
      lost.send("Target.attachToTarget", undefined, { targetId: "target-1" });
      if (peer !== "delivered peer") {
        await vi.waitFor(() => expect(f.held).toHaveLength(1));
      }
      const waiting =
        peer === "pending peer"
          ? other.send("Target.attachToTarget", undefined, { targetId: "target-1" })
          : undefined;
      const closing = lost.close();
      f.release();
      await closing;
      if (waiting !== undefined) {
        expect((await other.response(waiting)).error).toBeUndefined();
      }
      await flush();
      if (peer === "unrelated") {
        expect(f.commands("detach")).toHaveLength(before + 1);
      } else {
        expect(f.commands("detach")).toHaveLength(before);
        expect(other.attached()).toHaveLength(1);
      }
    },
  );

  it("rejects requested target substitution without retiring a pending peer's successor", async () => {
    const f = fixture();
    const c = f.client();
    await c.attach();
    f.extension.handlers.onMessage(
      JSON.stringify({ type: "detached", tabId: 1, reason: "target_closed" }),
    );
    f.hold("attach");
    const request = c.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    const peer = f.client();
    const pending = peer.send("Target.setAutoAttach", undefined, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.target("target-2");
    f.release();
    expect.soft((await c.response(request)).error).toBeDefined();
    await peer.response(pending);
    expect.soft(c.attached()).toHaveLength(1);
    expect(peer.attached()).toHaveLength(1);
    expect(peer.attached()[0]).toMatchObject({ targetInfo: { targetId: "target-2" } });
    expect(f.commands("detach")).toEqual([]);
  });

  it("never fabricates a successful native identity", async () => {
    const f = fixture();
    f.target(undefined);
    const c = f.client();
    await c.request("Target.setAutoAttach", undefined, enabled);
    expect(c.attached()).toEqual([]);
    expect((await c.request("Target.getTargets")).error).toBeDefined();
  });

  it("allows an explicit acquire after a failed retirement has settled", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    f.fail("detach");
    expect(
      (await c.request("Target.detachFromTarget", undefined, { sessionId: root })).error,
    ).toBeDefined();
    expect
      .soft((await c.request("Target.attachToTarget", undefined, { targetId: "target-1" })).error)
      .toBeUndefined();
    expect(f.commands("attach")).toHaveLength(2);
  });
});

describe("logical Target interests", () => {
  it("projects a child only to S2 when S1 was inserted first but never enabled", async () => {
    const f = fixture();
    const c = f.client();
    const s1 = await c.attach();
    const s2 = await c.alias();
    await c.request("Target.setAutoAttach", s2, enabled);
    f.child("child");
    expect.soft(c.attached(s1)).toEqual([]);
    expect(c.attached(s2)).toHaveLength(1);
  });

  it("keeps distinct child aliases and the surviving parent's Runtime/Fetch after parent detach", async () => {
    const f = fixture();
    const c = f.client();
    const s1 = await c.attach();
    const s2 = await c.alias();
    for (const parent of [s1, s2]) {
      await c.request("Target.setAutoAttach", parent, enabled);
    }
    f.child("child");
    const a = childId(c, s1);
    const b = childId(c, s2);
    expect(a).not.toBe(b);
    await c.request("Fetch.enable", b, {});
    expect((await c.request("Fetch.enable", a, {})).error).toBeDefined();
    await c.request("Target.detachFromTarget", undefined, { sessionId: s1 });
    for (const method of ["Runtime.enable", "Runtime.evaluate", "Fetch.disable"]) {
      expect((await c.request(method, b)).error).toBeUndefined();
    }
    expect(f.commands("Target.detachFromTarget")).toEqual([]);
    expect(c.socket.frames()).toContainEqual({
      sessionId: s1,
      method: "Target.detachedFromTarget",
      params: { sessionId: a, targetId: "target-child" },
    });
  });

  it("replays late children and grandchildren only after current admission with current waiting state", async () => {
    const f = fixture();
    const c = f.client();
    const s1 = await c.attach();
    await c.request("Target.setAutoAttach", s1, enabled);
    f.child("child");
    const a = childId(c, s1);
    await c.request("Target.setAutoAttach", a, enabled);
    f.child("grandchild", "child");
    await c.request("Runtime.runIfWaitingForDebugger", a);
    const s2 = await c.alias();
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", s2, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect(c.attached(s2)).toEqual([]);
    f.release();
    await c.response(pending);
    const b = childId(c, s2);
    expect(c.attached(s2)[0]).toMatchObject({ waitingForDebugger: false });
    expect(c.attached(b)).toEqual([]);
    await c.request("Target.setAutoAttach", b, enabled);
    expect(c.attached(b)).toHaveLength(1);
    expect(childId(c, a)).not.toBe(childId(c, b));
  });

  it("admits a broader filter before replaying its newly included children", async () => {
    const f = fixture();
    const c = f.client();
    const first = await c.attach();
    const peer = await c.alias();
    await c.request("Target.setAutoAttach", first, {
      ...enabled,
      filter: [{ type: "worker" }],
    });
    await c.request("Target.setAutoAttach", peer, { ...enabled, filter: [{}] });
    f.child("frame", undefined, "iframe");
    expect(c.attached(first)).toEqual([]);
    expect(c.attached(peer)).toHaveLength(1);
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", first, { ...enabled, filter: [{}] });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect.soft(c.attached(first)).toEqual([]);
    f.release();
    expect((await c.response(pending)).error).toBeUndefined();
    expect(c.attached(first)).toHaveLength(1);
    expect(childId(c, first)).not.toBe(childId(c, peer));
  });

  it("unions ordered native filters without conflating omitted filter and catch-all", async () => {
    const f = fixture();
    const c = f.client();
    const s1 = await c.attach();
    const s2 = await c.alias();
    expect((await c.request("Target.setAutoAttach", s1, enabled)).error).toBeUndefined();
    expect(
      (await c.request("Target.setAutoAttach", s2, { ...enabled, filter: [{}] })).error,
    ).toBeUndefined();
    f.child("tab", undefined, "tab");
    f.child("worker");
    expect.soft(c.attached(s1)).toHaveLength(1);
    expect(c.attached(s2)).toHaveLength(2);
    await c.request("Target.setAutoAttach", s1, { ...enabled, waitForDebuggerOnStart: false });
    expect(f.commands("Target.setAutoAttach").at(-1)?.params).toMatchObject({
      waitForDebuggerOnStart: false,
      filter: [{}],
    });
    await c.request("Target.setAutoAttach", s2, {
      ...enabled,
      filter: [{ type: "worker", exclude: true }, {}],
    });
    f.child("next-worker");
    expect(c.attached(s1)).toHaveLength(2);
    expect(c.attached(s2)).toHaveLength(2);
  });

  it.each(["enable", "disable"])(
    "retires uncertain native %s transitions visibly without disconnecting clients",
    async (transition) => {
      const f = fixture();
      const c = f.client();
      const root = await c.attach();
      if (transition === "disable") {
        await c.request("Target.setAutoAttach", root, enabled);
        f.child("child");
      }
      f.fail("Target.setAutoAttach");
      expect(
        (
          await c.request("Target.setAutoAttach", root, {
            ...enabled,
            autoAttach: transition === "enable",
          })
        ).error,
      ).toBeDefined();
      expect.soft((await c.request("Runtime.evaluate", root)).error).toBeDefined();
      expect(c.socket.closed).toBe(false);
      await flush();
      expect(f.commands("detach")).toHaveLength(1);
    },
  );

  it("cleans the last unused child without stranding its native wait", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Target.setAutoAttach", root, enabled);
    f.child("child");
    const child = childId(c, root);
    await c.request("Target.detachFromTarget", root, { sessionId: child });
    expect(f.commands("Target.detachFromTarget").at(-1)?.params).toEqual({ sessionId: "child" });
    expect((await c.request("Runtime.evaluate", root)).error).toBeUndefined();
  });

  it.each(["sessionId", "targetId"])(
    "routes non-flat child commands by %s through the same logical owner",
    async (selector) => {
      const f = fixture();
      const c = f.client();
      const root = await c.attach();
      await c.request("Target.setAutoAttach", root, { ...enabled, flatten: false });
      f.child("child");
      const child = childId(c, root);
      expect(child).not.toBe("child");
      await c.request("Target.sendMessageToTarget", root, {
        [selector]: selector === "sessionId" ? child : "target-child",
        message: JSON.stringify({
          id: 71,
          method: "Runtime.evaluate",
          params: { expression: "1" },
        }),
      });
      await vi.waitFor(() =>
        expect(c.socket.frames()).toContainEqual({
          sessionId: root,
          method: "Target.receivedMessageFromTarget",
          params: {
            sessionId: child,
            targetId: "target-child",
            message: JSON.stringify({ id: 71, result: { ok: true, echoed: "Runtime.evaluate" } }),
          },
        }),
      );
      expect(f.commands("Runtime.evaluate").at(-1)?.sessionId).toBe("child");
    },
  );
  it("updates cached child metadata only for interested parents", async () => {
    const f = fixture();
    const c = f.client();
    const unenabled = await c.attach();
    const parent = await c.alias();
    await c.request("Target.setAutoAttach", parent, enabled);
    f.child("child");
    const info = { targetId: "target-child", type: "worker", url: "https://example.com/updated" };
    f.event("Target.targetInfoChanged", { targetInfo: info });
    expect
      .soft(c.socket.frames().filter((frame) => frame.method === "Target.targetInfoChanged"))
      .toEqual([
        { sessionId: parent, method: "Target.targetInfoChanged", params: { targetInfo: info } },
      ]);
    await c.request("Target.setAutoAttach", unenabled, enabled);
    expect(c.attached(unenabled)[0]).toMatchObject({ targetInfo: info });
  });

  it("does not serialize ordinary commands or an independent child behind a parent transition", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Target.setAutoAttach", root, enabled);
    f.child("child");
    const child = childId(c, root);
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", root, {
      ...enabled,
      waitForDebuggerOnStart: false,
    });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect((await c.request("Runtime.evaluate", root)).error).toBeUndefined();
    expect((await c.request("Runtime.enable", root)).error).toBeUndefined();
    expect((await c.request("Fetch.enable", child)).error).toBeUndefined();
    f.hold(undefined);
    expect((await c.request("Target.setAutoAttach", child, enabled)).error).toBeUndefined();
    expect(c.socket.frames().find((frame) => frame.id === pending)).toBeUndefined();
    f.release();
    expect((await c.response(pending)).error).toBeUndefined();
  });

  it("retires a partially mutating enable and discards its late native child", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", root, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.child("child");
    expect(c.attached(root)).toEqual([]);
    f.extension.handlers.onMessage(
      JSON.stringify({
        type: "error",
        seq: f.held[0]!.seq,
        message: "post-command admission failed",
      }),
    );
    expect((await c.response(pending)).error).toBeDefined();
    f.child("late-child");
    expect(c.attached(root)).toEqual([]);
    expect((await c.request("Runtime.evaluate", root)).error).toBeDefined();
    expect(c.socket.closed).toBe(false);
  });

  it("does not reuse child aliases after the native parent is replaced", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Target.setAutoAttach", root, enabled);
    f.child("child");
    const old = childId(c, root);
    f.extension.handlers.onMessage(
      JSON.stringify({ type: "detached", tabId: 1, reason: "target_closed" }),
    );
    const next = await c.attach();
    await c.request("Target.setAutoAttach", next, enabled);
    f.child("child");
    const fresh = childId(c, next);
    expect(fresh).not.toBe(old);
    expect((await c.request("Runtime.evaluate", old)).error).toBeDefined();
    expect((await c.request("Runtime.evaluate", fresh)).error).toBeUndefined();
  });

  it("keeps synthetic browser-root pages visible for Puppeteer's browser filter", async () => {
    const f = fixture();
    const c = f.client();
    expect(
      (
        await c.request("Target.setAutoAttach", undefined, {
          ...enabled,
          filter: [{ type: "page", exclude: true }, {}],
        })
      ).error,
    ).toBeUndefined();
    expect(c.attached()).toHaveLength(1);
  });

  it("routes a flat descendant through its non-flat ancestor transport", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Target.setAutoAttach", root, { ...enabled, flatten: false });
    f.child("child");
    const child = childId(c, root);
    await c.request("Target.sendMessageToTarget", root, {
      sessionId: child,
      message: JSON.stringify({ id: 101, method: "Target.setAutoAttach", params: enabled }),
    });
    await flush();
    f.child("grandchild", "child");
    const nested = c.socket
      .frames()
      .filter((frame) => frame.method === "Target.receivedMessageFromTarget")
      .map((frame) => JSON.parse(String(asOptionalRecord(frame.params)?.message)));
    const grandchild = nested.find((frame) => frame.method === "Target.attachedToTarget")?.params
      .sessionId;
    expect(typeof grandchild).toBe("string");
    await c.request("Target.sendMessageToTarget", root, {
      sessionId: child,
      message: JSON.stringify({ id: 102, sessionId: grandchild, method: "Runtime.evaluate" }),
    });
    await flush();
    expect.soft(f.commands("Runtime.evaluate").at(-1)?.sessionId).toBe("grandchild");
    expect(c.socket.frames()).toContainEqual({
      sessionId: root,
      method: "Target.receivedMessageFromTarget",
      params: {
        sessionId: child,
        targetId: "target-child",
        message: JSON.stringify({
          id: 102,
          result: { ok: true, echoed: "Runtime.evaluate" },
          sessionId: grandchild,
        }),
      },
    });
  });

  it("does not detach an already-closed child after held Fetch cleanup finishes", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    await c.request("Target.setAutoAttach", root, enabled);
    f.child("child");
    const child = childId(c, root);
    await c.request("Fetch.enable", child);
    f.event("Fetch.requestPaused", { requestId: "paused" }, "child");
    f.hold("Fetch.failRequest");
    const detaching = c.send("Target.detachFromTarget", root, { sessionId: child });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "target-child" });
    f.fail("Target.detachFromTarget");
    f.release();
    expect.soft((await c.response(detaching)).error).toBeUndefined();
    expect.soft(f.commands("Target.detachFromTarget")).toEqual([]);
    expect((await c.request("Runtime.evaluate", root)).error).toBeUndefined();
  });
});
