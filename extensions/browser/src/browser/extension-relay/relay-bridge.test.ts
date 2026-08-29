import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Extension relay bridge: CDP target synthesis and extension command routing.
import { describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  FakeSocket,
  wireExtension,
  sendHello,
  defaultTabs,
  flush,
} from "./relay-bridge.test-support.js";
import type { RelayToExtensionMessage } from "./relay-protocol.js";

describe("ExtensionRelayBridge", () => {
  it("notifies connection waiters only after an authenticated valid hello", async () => {
    vi.useFakeTimers();
    const bridge = new ExtensionRelayBridge();
    try {
      const pending = wireExtension(bridge);
      let ready = false;
      const connected = bridge
        .waitForExtensionConnection(new AbortController().signal, 8_000)
        .then((result) => {
          ready = result;
        });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(ready).toBe(false);
      pending.handlers.onMessage(JSON.stringify({ type: "not-hello" }));
      await vi.advanceTimersByTimeAsync(100);
      expect(ready).toBe(false);

      const replacement = wireExtension(bridge);
      sendHello(replacement.handlers);
      await connected;

      expect(ready).toBe(true);
      expect(bridge.extensionConnected).toBe(true);
    } finally {
      bridge.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("releases pending connection waiters immediately when their relay is disposed", async () => {
    vi.useFakeTimers();
    const bridge = new ExtensionRelayBridge();
    try {
      const waiting = bridge.waitForExtensionConnection(new AbortController().signal, 8_000);

      bridge.dispose();

      await expect(waiting).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it("retires an unresponsive extension and immediately fails pending CDP work", async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const bridge = new ExtensionRelayBridge({ onStateChange });
    try {
      const { socket, handlers } = wireExtension(bridge);
      sendHello(handlers);

      const client = new FakeSocket();
      const cdp = bridge.attachCdpClientSocket(client);
      cdp.onMessage(
        JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const attached = client.frames().find((frame) => frame.method === "Target.attachedToTarget");
      const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
      expect(typeof sessionId).toBe("string");

      socket.send = (data) => FakeSocket.prototype.send.call(socket, data);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(socket.frames().filter((frame) => frame.type === "ping")).toHaveLength(2);

      cdp.onMessage(JSON.stringify({ id: 2, sessionId, method: "Page.getFrameTree" }));
      expect(socket.frames().at(-1)).toMatchObject({ type: "cdp", method: "Page.getFrameTree" });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(bridge.extensionConnected).toBe(true);
      expect(client.frames().find((frame) => frame.id === 2)).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      expect(socket).toMatchObject({
        closed: true,
        closeCode: 4000,
        closeReason: "extension heartbeat timeout",
      });
      expect(bridge.extensionConnected).toBe(false);
      expect(client.frames().find((frame) => frame.id === 2)).toMatchObject({
        error: { message: "extension disconnected" },
      });
      expect(onStateChange).toHaveBeenCalledTimes(2);

      handlers.onClose();
      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps an extension alive when each heartbeat receives an immediate pong", async () => {
    vi.useFakeTimers();
    const bridge = new ExtensionRelayBridge();
    try {
      const { socket, handlers } = wireExtension(bridge);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        send(data);
        if ((JSON.parse(data) as { type: string }).type === "ping") {
          handlers.onMessage(JSON.stringify({ type: "pong" }));
        }
      };
      sendHello(handlers);

      await vi.advanceTimersByTimeAsync(120_000);

      expect(socket.frames().filter((frame) => frame.type === "ping")).toHaveLength(6);
      expect(socket.closed).toBe(false);
      expect(bridge.extensionConnected).toBe(true);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it("gives a replacement extension its own heartbeat budget and ignores stale owners", async () => {
    vi.useFakeTimers();
    const bridge = new ExtensionRelayBridge();
    try {
      const previous = wireExtension(bridge);
      sendHello(previous.handlers);
      await vi.advanceTimersByTimeAsync(40_000);

      const replacement = wireExtension(bridge);
      sendHello(replacement.handlers);
      expect(previous.socket.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(40_000);
      previous.handlers.onMessage(JSON.stringify({ type: "pong" }));
      previous.handlers.onClose();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(replacement.socket.closed).toBe(false);
      expect(bridge.extensionConnected).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(replacement.socket).toMatchObject({
        closed: true,
        closeCode: 4000,
        closeReason: "extension heartbeat timeout",
      });
      expect(bridge.extensionConnected).toBe(false);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it("clears the extension heartbeat when its bridge is disposed", async () => {
    vi.useFakeTimers();
    const bridge = new ExtensionRelayBridge();
    try {
      const { socket, handlers } = wireExtension(bridge);
      sendHello(handlers);
      expect(vi.getTimerCount()).toBe(1);

      bridge.dispose();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.frames().filter((frame) => frame.type === "ping")).toHaveLength(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it("reports the paired browser identity through Browser.getVersion", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);
    expect(bridge.extensionConnected).toBe(true);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await flush();

    const response = client.frames().find((frame) => frame.id === 1);
    expect(response?.result).toMatchObject({
      protocolVersion: "1.3",
      product: "Chrome/144.0.0.0",
    });
  });

  it("attaches accessible tabs and announces targets on Target.setAutoAttach", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    const attached = client.frames().find((frame) => frame.method === "Target.attachedToTarget");
    expect(attached).toBeTruthy();
    const params = attached?.params as {
      targetInfo?: { targetId?: string; browserContextId?: string };
      sessionId?: string;
    };
    expect(params.targetInfo?.targetId).toBe("target-1");
    expect(params.targetInfo?.browserContextId).toBe("openclaw-extension-context");
    expect(typeof params.sessionId).toBe("string");
  });

  it("routes session-scoped CDP commands to the owning tab", async () => {
    const bridge = new ExtensionRelayBridge();
    const { socket: extSocket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    const attached = client.frames().find((frame) => frame.method === "Target.attachedToTarget");
    expect(attached).toBeTruthy();
    const sessionId = (attached?.params as { sessionId: string })?.sessionId;

    cdp.onMessage(
      JSON.stringify({
        id: 2,
        sessionId,
        method: "Page.navigate",
        params: { url: "https://x.test" },
      }),
    );
    await flush();

    // The extension received a session-forwarded cdp command for tab 1.
    const forwarded = extSocket
      .frames()
      .find((frame) => frame.type === "cdp" && frame.method === "Page.navigate");
    expect(forwarded).toMatchObject({ tabId: 1, method: "Page.navigate" });
    const response = client.frames().find((frame) => frame.id === 2);
    expect(response?.result).toMatchObject({ ok: true });
  });

  it("multiplexes Playwright page CDP sessions over the accessible tab attachment", async () => {
    const bridge = new ExtensionRelayBridge();
    const { socket: extSocket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await flush();
    const browserSessionId = (
      client.frames().find((frame) => frame.id === 2)?.result as { sessionId?: string }
    )?.sessionId;
    expect(browserSessionId).toBeTruthy();

    cdp.onMessage(
      JSON.stringify({
        id: 3,
        sessionId: browserSessionId,
        method: "Target.attachToTarget",
        params: { targetId: "target-1", flatten: true },
      }),
    );
    await flush();
    const pageSessionId = (
      client.frames().find((frame) => frame.id === 3)?.result as { sessionId?: string }
    )?.sessionId;
    expect(pageSessionId).toBeTruthy();
    expect(pageSessionId).not.toBe(browserSessionId);

    cdp.onMessage(
      JSON.stringify({ id: 4, sessionId: pageSessionId, method: "Runtime.evaluate", params: {} }),
    );
    await flush();
    expect(
      extSocket
        .frames()
        .find((frame) => frame.type === "cdp" && frame.method === "Runtime.evaluate"),
    ).toMatchObject({ tabId: 1, method: "Runtime.evaluate" });
    expect(client.frames().find((frame) => frame.id === 4)?.result).toMatchObject({ ok: true });

    cdp.onMessage(JSON.stringify({ id: 6, sessionId: pageSessionId, method: "Runtime.enable" }));
    await flush();
    handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        method: "Runtime.consoleAPICalled",
        params: { type: "log" },
      }),
    );
    await flush();
    expect(
      client
        .frames()
        .find(
          (frame) =>
            frame.sessionId === pageSessionId && frame.method === "Runtime.consoleAPICalled",
        ),
    ).toMatchObject({ params: { type: "log" } });

    const otherClient = new FakeSocket();
    const otherCdp = bridge.attachCdpClientSocket(otherClient);
    otherCdp.onMessage(
      JSON.stringify({
        id: 1,
        method: "Target.detachFromTarget",
        params: { sessionId: pageSessionId },
      }),
    );
    await flush();
    expect(otherClient.frames().find((frame) => frame.id === 1)?.error).toMatchObject({
      code: -32001,
    });

    cdp.onMessage(
      JSON.stringify({
        id: 5,
        sessionId: browserSessionId,
        method: "Target.detachFromTarget",
        params: { sessionId: pageSessionId },
      }),
    );
    await flush();
    expect(client.frames().find((frame) => frame.id === 5)?.result).toEqual({});
  });

  it("creates a tab inside the group and returns its synthetic target", async () => {
    const bridge = new ExtensionRelayBridge();
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    cdp.onMessage(
      JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: "https://new.test" } }),
    );
    await flush();

    const response = client.frames().find((frame) => frame.id === 2);
    expect(response?.result).toMatchObject({ targetId: "target-999" });
    expect(socket.frames().find((frame) => frame.type === "createTab")).toMatchObject({
      url: "https://new.test",
      background: true,
      focus: false,
    });
  });

  it("preserves an explicit foreground Target.createTarget request", async () => {
    const bridge = new ExtensionRelayBridge();
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({
        id: 1,
        method: "Target.createTarget",
        params: { url: "https://foreground.test", background: false },
      }),
    );
    await flush();

    expect(client.frames().find((frame) => frame.id === 1)?.result).toMatchObject({
      targetId: "target-999",
    });
    expect(socket.frames().find((frame) => frame.type === "createTab")).toMatchObject({
      url: "https://foreground.test",
      background: false,
      focus: true,
    });
  });

  it.each(["active", "closed client", "replaced extension"])(
    "binds an atomic creation reply to its current owner: %s",
    async (lifecycle) => {
      const bridge = new ExtensionRelayBridge();
      try {
        const socket = new FakeSocket();
        const extension = bridge.attachExtensionSocket(socket);
        sendHello(extension, []);
        const client = new FakeSocket();
        const cdp = bridge.attachCdpClientSocket(client);
        cdp.onMessage(
          JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "" } }),
        );
        const command = socket.frames().at(-1);
        expect(command).toMatchObject({ type: "createTab", url: "about:blank" });
        extension.onMessage(
          JSON.stringify({
            type: "result",
            seq: command?.seq,
            result: { tabId: 99, targetId: "created-target" },
          }),
        );
        // Resolve the old promise, then replace its owner before its continuation.
        if (lifecycle === "closed client") {
          cdp.onClose();
        }
        if (lifecycle === "replaced extension") {
          sendHello(wireExtension(bridge).handlers, []);
        }
        await flush();
        expect(socket.frames().filter((frame) => frame.type === "attach")).toEqual([]);
        if (lifecycle === "active") {
          expect(client.frames().map((frame) => frame.method ?? frame.id)).toEqual([
            "Target.attachedToTarget",
            1,
          ]);
          expect(client.frames().at(-1)?.result).toEqual({ targetId: "created-target" });
        } else {
          expect(client.frames()).toEqual([]);
          expect(bridge.accessibleTabs()).toEqual([]);
          expect(socket.frames().filter((frame) => frame.type === "detach")).toEqual(
            lifecycle === "closed client" ? [expect.objectContaining({ tabId: 99 })] : [],
          );
        }
      } finally {
        bridge.dispose();
      }
    },
  );

  it.each([true, false])(
    "honors an explicit Target.createTarget focus=%s request",
    async (focus) => {
      const bridge = new ExtensionRelayBridge();
      const { socket, handlers } = wireExtension(bridge);
      sendHello(handlers);

      const client = new FakeSocket();
      const cdp = bridge.attachCdpClientSocket(client);
      cdp.onMessage(
        JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url: "https://focused.test", focus },
        }),
      );
      await flush();

      expect(client.frames().find((frame) => frame.id === 1)?.result).toMatchObject({
        targetId: "target-999",
      });
      expect(socket.frames().find((frame) => frame.type === "createTab")).toMatchObject({
        url: "https://focused.test",
        background: false,
        focus,
      });
    },
  );

  it("emits Target.detachedFromTarget when a tab becomes unavailable", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    // Tab 1 removed from the accessible set.
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    await flush();

    const detached = client.frames().find((frame) => frame.method === "Target.detachedFromTarget");
    expect(detached).toBeTruthy();
    expect(bridge.accessibleTabs()).toHaveLength(0);
  });

  it("rejects isolated browser contexts (real profile only)", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.createBrowserContext" }));
    await flush();

    const response = client.frames().find((frame) => frame.id === 1);
    expect(response?.error).toBeTruthy();
  });

  it("fails pending commands when the extension disconnects", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    handlers.onClose();
    // A subsequent session command should surface a clean error, not hang.
    cdp.onMessage(JSON.stringify({ id: 2, sessionId: "openclaw-tab-1-1", method: "Page.reload" }));
    await flush();
    const response = client.frames().find((frame) => frame.id === 2);
    expect(response?.error).toBeTruthy();
    expect(bridge.extensionConnected).toBe(false);
  });

  it("repairs reconnect attach without undoing a later explicit detach", async () => {
    const bridge = new ExtensionRelayBridge();
    const initialSocket = new FakeSocket();
    const initial = bridge.attachExtensionSocket(initialSocket);
    sendHello(initial);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    expect(initialSocket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    await flush();

    expect(replacement.socket.frames().filter((frame) => frame.type === "attach")).toEqual([
      expect.objectContaining({ tabId: 1 }),
    ]);
    cdp.onMessage(JSON.stringify({ id: 2, method: "Target.getTargets" }));
    await flush();
    expect(client.frames().find((frame) => frame.id === 2)?.result).toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "target-1" })],
    });

    const attached = client
      .frames()
      .findLast((frame) => frame.method === "Target.attachedToTarget");
    const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof sessionId).toBe("string");
    cdp.onMessage(
      JSON.stringify({ id: 3, method: "Target.detachFromTarget", params: { sessionId } }),
    );
    await flush();
    const afterDetach = wireExtension(bridge);
    sendHello(afterDetach.handlers, [
      { tabId: 1, url: "https://example.com", title: "Updated", active: true },
    ]);
    await flush();

    expect(afterDetach.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(0);
    cdp.onMessage(JSON.stringify({ id: 4, method: "Target.getTargets" }));
    await flush();
    expect(client.frames().find((frame) => frame.id === 4)).toMatchObject({
      error: { message: expect.stringMatching(/target identit.*unavailable/i) },
    });
  });

  it("does not project a disconnected zero-tab extension as authoritative empty", async () => {
    const bridge = new ExtensionRelayBridge();
    const extension = wireExtension(bridge);
    sendHello(extension.handlers, []);
    extension.handlers.onClose();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    await flush();

    expect(client.frames().find((frame) => frame.id === 1)).toMatchObject({
      error: { message: expect.stringMatching(/extension.*disconnected/i) },
    });
  });

  it("does not project a mixed attached target list as authoritative", async () => {
    const bridge = new ExtensionRelayBridge();
    const extension = wireExtension(bridge);
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();
    cdp.onMessage(
      JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: false } }),
    );
    extension.handlers.onMessage(
      JSON.stringify({
        type: "tabs",
        tabs: [
          { tabId: 1, url: "https://one.example", title: "One", active: true },
          { tabId: 2, url: "https://two.example", title: "Two", active: false },
        ],
      }),
    );
    await flush();

    cdp.onMessage(JSON.stringify({ id: 3, method: "Target.getTargets" }));
    await flush();

    expect(client.frames().find((frame) => frame.id === 3)).toMatchObject({
      error: { message: expect.stringMatching(/target identit.*unavailable/i) },
    });
  });

  it("reports malformed CDP client JSON instead of leaving the client waiting", () => {
    const bridge = new ExtensionRelayBridge();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage("{");

    expect(client.frames()).toEqual([
      { id: null, error: { code: -32700, message: "Parse error" } },
    ]);
  });

  it("reports invalid CDP client requests instead of leaving the client waiting", () => {
    const bridge = new ExtensionRelayBridge();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage(JSON.stringify({ id: 7, sessionId: "session-1", params: {} }));

    expect(client.frames()).toEqual([
      {
        id: 7,
        sessionId: "session-1",
        error: { code: -32600, message: "Invalid request" },
      },
    ]);
  });

  it("reaps child sessions when a tab becomes unavailable (no stale routing)", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    const rootEvent = client.frames().find((frame) => frame.method === "Target.attachedToTarget");
    const root = asOptionalRecord(rootEvent?.params)?.sessionId;
    expect(typeof root).toBe("string");
    cdp.onMessage(
      JSON.stringify({
        id: 10,
        sessionId: root,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      }),
    );
    await flush();
    handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child-abc",
          targetInfo: { targetId: "child-target", type: "iframe" },
          waitingForDebugger: false,
        },
      }),
    );
    const childEvent = client
      .frames()
      .findLast((frame) => frame.method === "Target.attachedToTarget");
    const child = asOptionalRecord(childEvent?.params)?.sessionId;
    expect(typeof child).toBe("string");
    expect(child).not.toBe(root);
    // Extension reports a child (iframe) session for tab 1.
    handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        sessionId: "child-abc",
        method: "Page.frameNavigated",
        params: {},
      }),
    );
    await flush();

    // Tab 1 disappears from the extension's accessible set.
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    await flush();

    // A command addressed to the now-stale child session must not route to a
    // reused tab; it should surface a clean "session not found" error.
    cdp.onMessage(JSON.stringify({ id: 2, sessionId: child, method: "Page.reload" }));
    await flush();
    const response = client.frames().find((frame) => frame.id === 2);
    expect(response?.error).toBeTruthy();
  });

  it("requires a hello frame before other extension messages", () => {
    const bridge = new ExtensionRelayBridge();
    const socket = new FakeSocket();
    const handlers = bridge.attachExtensionSocket(socket);
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    expect(socket.closed).toBe(true);
    expect(bridge.extensionConnected).toBe(false);
  });

  it("keeps the active extension while a candidate is pending, malformed, or closed", () => {
    const bridge = new ExtensionRelayBridge();
    const active = wireExtension(bridge);
    sendHello(active.handlers);

    const pendingSocket = new FakeSocket();
    const pending = bridge.attachExtensionSocket(pendingSocket);
    expect(active.socket.closed).toBe(false);
    expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");

    pending.onClose();
    sendHello(pending);
    expect(bridge.extensionConnected).toBe(true);
    expect(active.socket.closed).toBe(false);

    const malformedSocket = new FakeSocket();
    const malformed = bridge.attachExtensionSocket(malformedSocket);
    malformed.onMessage(
      JSON.stringify({
        type: "hello",
        userAgent: "candidate",
        browserVersion: "Chrome/145.0.0.0",
        extensionVersion: "2.0.0",
      }),
    );
    expect(malformedSocket).toMatchObject({
      closed: true,
      closeCode: 4001,
      closeReason: "expected valid hello",
    });
    expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");
    expect(active.socket.closed).toBe(false);
  });

  it("replaces the active extension only after the candidate sends a valid hello", () => {
    const bridge = new ExtensionRelayBridge();
    const active = wireExtension(bridge);
    sendHello(active.handlers);

    const candidateSocket = new FakeSocket();
    const candidate = bridge.attachExtensionSocket(candidateSocket);
    sendHello(candidate, [
      { tabId: 2, url: "https://candidate.example", title: "Candidate", active: true },
    ]);

    expect(active.socket).toMatchObject({
      closed: true,
      closeCode: 4000,
      closeReason: "replaced by newer extension connection",
    });
    expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");
    expect(bridge.accessibleTabs()).toEqual([
      { tabId: 2, url: "https://candidate.example", title: "Candidate", active: true },
    ]);

    active.handlers.onClose();
    expect(bridge.extensionConnected).toBe(true);
    expect(bridge.accessibleTabs()).toHaveLength(1);
  });

  it("rejects an older candidate when a newer candidate promotes first", () => {
    const bridge = new ExtensionRelayBridge();
    const active = wireExtension(bridge);
    sendHello(active.handlers);

    const firstSocket = new FakeSocket();
    const first = bridge.attachExtensionSocket(firstSocket);
    const secondSocket = new FakeSocket();
    const second = bridge.attachExtensionSocket(secondSocket);
    expect(active.socket.closed).toBe(false);

    second.onMessage(
      JSON.stringify({
        type: "hello",
        userAgent: "second",
        browserVersion: "Chrome/146.0.0.0",
        extensionVersion: "2.0.0",
        tabs: [],
      }),
    );
    expect(active.socket.closed).toBe(true);
    expect(firstSocket.closed).toBe(false);
    expect(secondSocket.closed).toBe(false);
    expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");

    first.onMessage(
      JSON.stringify({
        type: "hello",
        userAgent: "first",
        browserVersion: "Chrome/145.0.0.0",
        extensionVersion: "2.0.0",
        tabs: [],
      }),
    );
    expect(firstSocket).toMatchObject({
      closed: true,
      closeCode: 4000,
      closeReason: "superseded by newer extension connection",
    });
    expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");

    first.onClose();
    active.handlers.onClose();
    expect(bridge.extensionConnected).toBe(true);
    expect(secondSocket.closed).toBe(false);
  });

  it("answers the Puppeteer connect bootstrap without protocol errors", async () => {
    // The exact browser-scoped sequence puppeteer.connect() issues before any
    // page work (chrome-devtools-mcp --browserUrl/--wsEndpoint rides this).
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    const bootstrap: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [
      { id: 1, method: "Browser.getVersion" },
      { id: 2, method: "Target.setDiscoverTargets", params: { discover: true } },
      {
        id: 3,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      },
      { id: 4, method: "Target.getBrowserContexts" },
    ];
    for (const message of bootstrap) {
      cdp.onMessage(JSON.stringify(message));
    }
    await flush();

    for (const message of bootstrap) {
      const response = client.frames().find((frame) => frame.id === message.id);
      expect(response, `response for ${message.method}`).toBeTruthy();
      expect(response?.error, `error for ${message.method}`).toBeUndefined();
    }
    const contexts = client.frames().find((frame) => frame.id === 4);
    // Only createBrowserContext-made contexts belong here; the relay drives the
    // real profile's default context, so the list is always empty (as in Chrome).
    expect(contexts?.result).toEqual({ browserContextIds: [] });
  });

  it("lists accessible tabs as DevTools-style target descriptors", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    expect(bridge.devtoolsTargetDescriptors()).toEqual([
      {
        tabId: 1,
        url: "https://example.com",
        title: "Example",
        active: true,
        id: "tab-1",
        type: "page",
      },
    ]);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    // Once the debugger attaches, descriptors carry the live targetId.
    expect(bridge.devtoolsTargetDescriptors()[0]).toMatchObject({ id: "target-1", type: "page" });
  });

  it("keeps operation identity on the same granted tab across renderer reattachment", async () => {
    const bridge = new ExtensionRelayBridge();
    try {
      const extension = wireExtension(bridge);
      let targetId = "original-target";
      const send = extension.socket.send.bind(extension.socket);
      extension.socket.send = (data) => {
        const command = JSON.parse(data) as RelayToExtensionMessage;
        if (command.type !== "attach") {
          send(data);
          return;
        }
        FakeSocket.prototype.send.call(extension.socket, data);
        queueMicrotask(() => {
          extension.handlers.onMessage(
            JSON.stringify({ type: "result", seq: command.seq, result: { targetId } }),
          );
        });
      };
      sendHello(extension.handlers);
      const cdp = bridge.attachCdpClientSocket(new FakeSocket());
      cdp.onMessage(
        JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      await flush();
      const resolveTarget = bridge.captureOperationTarget("original-target");
      expect(resolveTarget?.()).toBe("original-target");

      extension.handlers.onMessage(
        JSON.stringify({ type: "detached", tabId: 1, reason: "renderer replaced" }),
      );
      expect(resolveTarget?.()).toBeUndefined();
      targetId = "replacement-target";
      cdp.onMessage(
        JSON.stringify({ id: 2, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      await flush();

      expect(resolveTarget?.()).toBe("replacement-target");
    } finally {
      bridge.dispose();
    }
  });

  it("invalidates captured operation identity when access is revoked and regranted", async () => {
    const bridge = new ExtensionRelayBridge();
    try {
      const extension = wireExtension(bridge);
      sendHello(extension.handlers);
      const cdp = bridge.attachCdpClientSocket(new FakeSocket());
      cdp.onMessage(
        JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      await flush();
      const resolveTarget = bridge.captureOperationTarget("target-1");

      extension.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
      extension.handlers.onMessage(JSON.stringify({ type: "tabs", tabs: defaultTabs() }));
      await flush();

      expect(resolveTarget?.()).toBeUndefined();
      expect(bridge.captureOperationTarget("target-1")?.()).toBe("target-1");
    } finally {
      bridge.dispose();
    }
  });

  it("invalidates captured operation identity when another extension reconnects", async () => {
    const bridge = new ExtensionRelayBridge();
    try {
      const original = wireExtension(bridge);
      sendHello(original.handlers);
      const cdp = bridge.attachCdpClientSocket(new FakeSocket());
      cdp.onMessage(
        JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      await flush();
      const resolveTarget = bridge.captureOperationTarget("target-1");

      const replacement = wireExtension(bridge);
      sendHello(replacement.handlers);
      await flush();

      expect(resolveTarget?.()).toBeUndefined();
      expect(bridge.captureOperationTarget("target-1")?.()).toBe("target-1");
    } finally {
      bridge.dispose();
    }
  });
});
