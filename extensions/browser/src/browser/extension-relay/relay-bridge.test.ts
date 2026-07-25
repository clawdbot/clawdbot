// Extension relay bridge: CDP target synthesis and extension command routing.
import { describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import type { ExtensionToRelayMessage, RelayToExtensionMessage } from "./relay-protocol.js";

/** In-memory socket capturing every frame the bridge sends. */
class FakeSocket {
  readonly sent: unknown[] = [];
  closed = false;
  closeCode?: number;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }
  /** Frames of a given method (client CDP responses/events). */
  frames(): Array<Record<string, unknown>> {
    return this.sent as Array<Record<string, unknown>>;
  }
}

/**
 * Scripted extension: auto-answers relay commands so the bridge can complete
 * attach/CDP round-trips. Attach returns a deterministic targetId per tab.
 */
function wireExtension(bridge: ExtensionRelayBridge) {
  const socket = new FakeSocket();
  const handlers = bridge.attachExtensionSocket(socket);
  // Auto-reply to commands the bridge issues to the extension.
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const msg = JSON.parse(data) as RelayToExtensionMessage;
    if (msg.type === "ping") {
      return;
    }
    queueMicrotask(() => {
      const reply = replyFor(msg);
      if (reply) {
        handlers.onMessage(JSON.stringify(reply));
      }
    });
  };
  return { socket, handlers };
}

function replyFor(msg: RelayToExtensionMessage): ExtensionToRelayMessage | null {
  switch (msg.type) {
    case "attach":
      return { type: "result", seq: msg.seq, result: { targetId: `target-${msg.tabId}` } };
    case "detach":
    case "activateTab":
    case "closeTab":
      return { type: "result", seq: msg.seq, result: {} };
    case "createTab":
      return { type: "result", seq: msg.seq, result: { tabId: 999 } };
    case "cdp":
      return { type: "result", seq: msg.seq, result: { ok: true, echoed: msg.method } };
    default:
      return null;
  }
}

function sendHello(handlers: { onMessage: (raw: string) => void }, tabs = defaultTabs()) {
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
      browserVersion: "Chrome/144.0.0.0",
      extensionVersion: "2.0.0",
      tabs,
    }),
  );
}

function defaultTabs() {
  return [{ tabId: 1, url: "https://example.com", title: "Example", active: true }];
}

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe("ExtensionRelayBridge", () => {
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

  it("attaches shared tabs and announces targets on Target.setAutoAttach", async () => {
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

  it("multiplexes Playwright page CDP sessions over the shared tab attachment", async () => {
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

  it("emits Target.detachedFromTarget when a shared tab leaves the group", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

    // Tab 1 removed from the shared set.
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    await flush();

    const detached = client.frames().find((frame) => frame.method === "Target.detachedFromTarget");
    expect(detached).toBeTruthy();
    expect(bridge.sharedTabs()).toHaveLength(0);
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

  it("reaps child sessions when a tab leaves the group (no stale routing)", async () => {
    const bridge = new ExtensionRelayBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    cdp.onMessage(
      JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await flush();

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

    // Tab 1 leaves the OpenClaw group.
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    await flush();

    // A command addressed to the now-stale child session must not route to a
    // reused tab; it should surface a clean "session not found" error.
    cdp.onMessage(JSON.stringify({ id: 2, sessionId: "child-abc", method: "Page.reload" }));
    await flush();
    const response = client.frames().find((frame) => frame.id === 2);
    expect(response?.error).toBeTruthy();
  });

  it("delivers a valid page share and acknowledges success", async () => {
    const onPageShare = vi.fn(async () => undefined);
    const bridge = new ExtensionRelayBridge({ onPageShare });
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);
    const payload = {
      url: "https://example.com/article",
      title: "Example",
      content: "Article body",
    };

    handlers.onMessage(JSON.stringify({ type: "pageShare", requestId: 41, payload }));
    await flush();

    expect(onPageShare).toHaveBeenCalledWith(payload);
    expect(socket.frames()).toContainEqual({
      type: "pageShareResult",
      requestId: 41,
      ok: true,
    });
  });

  it("returns the delivery error when the page-share handler rejects", async () => {
    const bridge = new ExtensionRelayBridge({
      onPageShare: async () => {
        throw new Error("queue unavailable");
      },
    });
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    handlers.onMessage(
      JSON.stringify({
        type: "pageShare",
        requestId: 42,
        payload: { url: "https://example.com", title: "Example", content: "Body" },
      }),
    );
    await flush();

    expect(socket.frames()).toContainEqual({
      type: "pageShareResult",
      requestId: 42,
      ok: false,
      error: "queue unavailable",
    });
  });

  it("explains that page shares require a gateway-hosted relay", async () => {
    const bridge = new ExtensionRelayBridge();
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    handlers.onMessage(
      JSON.stringify({
        type: "pageShare",
        requestId: 43,
        payload: { url: "https://example.com", title: "Example", content: "Body" },
      }),
    );
    await flush();

    expect(socket.frames()).toContainEqual({
      type: "pageShareResult",
      requestId: 43,
      ok: false,
      error:
        "Send to OpenClaw needs the extension relay hosted by the Gateway (pair on the Gateway host or use direct Gateway pairing). Node-hosted relays are not supported yet.",
    });
  });

  it("rejects invalid and oversized page-share payloads before delivery", async () => {
    const onPageShare = vi.fn(async () => undefined);
    const bridge = new ExtensionRelayBridge({ onPageShare });
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    handlers.onMessage(
      JSON.stringify({
        type: "pageShare",
        requestId: 44,
        payload: { url: "https://example.com", title: 7, content: "Body" },
      }),
    );
    handlers.onMessage(
      JSON.stringify({
        type: "pageShare",
        requestId: 45,
        payload: {
          url: "https://example.com",
          title: "Example",
          content: "c".repeat(200_000),
          selection: "s".repeat(100_001),
        },
      }),
    );
    await flush();

    expect(onPageShare).not.toHaveBeenCalled();
    expect(socket.frames()).toEqual(
      expect.arrayContaining([
        {
          type: "pageShareResult",
          requestId: 44,
          ok: false,
          error: "Invalid page-share payload.",
        },
        {
          type: "pageShareResult",
          requestId: 45,
          ok: false,
          error: "Invalid page-share payload.",
        },
      ]),
    );
  });

  it("requires a hello frame before other extension messages", () => {
    const bridge = new ExtensionRelayBridge();
    const socket = new FakeSocket();
    const handlers = bridge.attachExtensionSocket(socket);
    handlers.onMessage(JSON.stringify({ type: "tabs", tabs: [] }));
    expect(socket.closed).toBe(true);
    expect(bridge.extensionConnected).toBe(false);
  });
});
