/* oxlint-disable unicorn/require-post-message-target-origin -- MessagePort has no targetOrigin. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { PluginUiBridgeController } from "./plugin-ui-bridge.ts";

function offerBridgePort(frame: HTMLIFrameElement, nonce: string) {
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    throw new Error("expected iframe window");
  }
  const channel = new MessageChannel();
  const childPort = channel.port1;
  const messages: unknown[] = [];
  childPort.addEventListener("message", (event) => messages.push(event.data));
  childPort.start();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { v: 1, type: "openclaw.pluginUi.ready", nonce },
      source: frameWindow,
      ports: [channel.port2],
    }),
  );
  return { childPort, messages };
}

async function connectBridge(
  params: {
    request?: ReturnType<typeof vi.fn>;
    sessionActions?: string[];
    allowChatNavigation?: boolean;
  } = {},
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow;
  if (!frameWindow) {
    throw new Error("expected iframe window");
  }
  const request = params.request ?? vi.fn(async () => ({ ok: true }));
  const navigateToChat = vi.fn();
  const bridge = new PluginUiBridgeController();
  bridge.sync({
    frame,
    key: "notes/settings",
    nonce: "notes-nonce",
    pluginId: "notes",
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    sessionKey: "agent:main:active",
    contextTokens: 64_000,
    sessionActions: params.sessionActions ?? ["save"],
    allowChatNavigation: params.allowChatNavigation ?? false,
    navigateToChat,
  });
  const offered = offerBridgePort(frame, "notes-nonce");
  await vi.waitFor(() => expect(offered.messages).toHaveLength(1));
  const connectMessage = offered.messages.shift() as Record<string, unknown>;
  return {
    bridge,
    childPort: offered.childPort,
    connectMessage,
    frame,
    navigateToChat,
    request,
    responses: offered.messages,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("PluginUiBridgeController", () => {
  it("invokes only a declared plugin action with the parent session context", async () => {
    const request = vi.fn(async () => ({ ok: true, result: { saved: true } }));
    const connected = await connectBridge({ request, sessionActions: ["save"] });

    expect(connected.connectMessage).toMatchObject({
      v: 1,
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["save"], navigateToChat: false },
      context: { sessionKey: "agent:main:active", revision: 1, contextTokens: 64_000 },
    });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "save-1",
      actionId: "save",
      contextRevision: 1,
      sessionKey: "agent:attacker:ignored",
      payload: { enabled: true },
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("plugins.sessionAction", {
      pluginId: "notes",
      actionId: "save",
      sessionKey: "agent:main:active",
      payload: { enabled: true },
    });
    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual({
        v: 1,
        type: "openclaw.pluginUi.response",
        id: "save-1",
        ok: true,
        contextRevision: 1,
        result: { ok: true, result: { saved: true } },
      }),
    );
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("rejects actions absent from the tab descriptor before Gateway dispatch", async () => {
    const connected = await connectBridge({ sessionActions: ["save"] });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "delete-1",
      actionId: "delete-everything",
      contextRevision: 1,
    });

    await vi.waitFor(() => expect(connected.responses).toHaveLength(1));
    expect(connected.request).not.toHaveBeenCalled();
    expect(connected.responses[0]).toMatchObject({
      id: "delete-1",
      ok: false,
      error: "Plugin UI action is not allowed",
    });
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("allows only explicitly enabled chat navigation", async () => {
    const connected = await connectBridge({ allowChatNavigation: true });
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.navigate",
      id: "navigate-1",
      target: "chat",
      contextRevision: 1,
      sessionKey: "agent:main:resumed",
    });

    await vi.waitFor(() =>
      expect(connected.navigateToChat).toHaveBeenCalledWith("agent:main:resumed"),
    );
    expect(connected.responses).toContainEqual({
      v: 1,
      type: "openclaw.pluginUi.response",
      id: "navigate-1",
      ok: true,
      contextRevision: 1,
    });
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("requires the registered document nonce before the first connection", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    const request = vi.fn();
    const bridge = new PluginUiBridgeController();
    bridge.sync({
      frame,
      key: "notes/settings",
      nonce: "registered-document",
      pluginId: "notes",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:active",
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });
    frame.dispatchEvent(new Event("load"));
    const redirected = offerBridgePort(frame, "off-route-document");
    redirected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "redirected-save",
      actionId: "save",
      contextRevision: 1,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(redirected.messages).toEqual([]);
    expect(postMessage).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    bridge.clear();
    redirected.childPort.close();
  });

  it("ignores a repeated port offer after the bridge is connected", async () => {
    const connected = await connectBridge();
    const repeated = offerBridgePort(connected.frame, "notes-nonce");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(repeated.messages).toEqual([]);
    connected.bridge.clear();
    connected.childPort.close();
    repeated.childPort.close();
  });

  it("revokes the bridge when the active iframe navigates", async () => {
    const connected = await connectBridge();
    connected.frame.dispatchEvent(new Event("load"));

    connected.frame.dispatchEvent(new Event("load"));
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "retired-save",
      actionId: "save",
      contextRevision: 1,
    });
    const navigation = offerBridgePort(connected.frame, "notes-nonce");
    navigation.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "off-route-save",
      actionId: "save",
      contextRevision: 1,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(navigation.messages).toEqual([]);
    expect(connected.request).not.toHaveBeenCalled();
    connected.bridge.clear();
    connected.childPort.close();
    navigation.childPort.close();
  });

  it("updates the active port and rejects requests from its prior session context", async () => {
    const connected = await connectBridge();
    const request = vi.fn(async () => ({ ok: true, result: { saved: true } }));
    connected.bridge.sync({
      frame: connected.frame,
      key: "notes/settings",
      nonce: "notes-nonce",
      pluginId: "notes",
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:refreshed",
      contextTokens: 128_000,
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual({
        v: 1,
        type: "openclaw.pluginUi.update",
        capabilities: { sessionActions: ["save"], navigateToChat: false },
        context: {
          sessionKey: "agent:main:refreshed",
          revision: 2,
          contextTokens: 128_000,
        },
      }),
    );
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "save-stale",
      actionId: "save",
      contextRevision: 1,
    });
    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual(
        expect.objectContaining({
          id: "save-stale",
          ok: false,
          error: "Plugin UI session context is stale",
        }),
      ),
    );
    expect(request).not.toHaveBeenCalled();

    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "save-refreshed",
      actionId: "save",
      contextRevision: 2,
      payload: { enabled: true },
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("plugins.sessionAction", {
        pluginId: "notes",
        actionId: "save",
        sessionKey: "agent:main:refreshed",
        payload: { enabled: true },
      }),
    );
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("advances the context revision when the trusted context window changes", async () => {
    const connected = await connectBridge();
    connected.bridge.sync({
      frame: connected.frame,
      key: "notes/settings",
      nonce: "notes-nonce",
      pluginId: "notes",
      client: { request: connected.request } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:active",
      contextTokens: 128_000,
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual(
        expect.objectContaining({
          type: "openclaw.pluginUi.update",
          context: {
            sessionKey: "agent:main:active",
            revision: 2,
            contextTokens: 128_000,
          },
        }),
      ),
    );
    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "stale-context-window",
      actionId: "save",
      contextRevision: 1,
    });
    await vi.waitFor(() =>
      expect(connected.responses).toContainEqual(
        expect.objectContaining({
          id: "stale-context-window",
          ok: false,
          error: "Plugin UI session context is stale",
        }),
      ),
    );
    expect(connected.request).not.toHaveBeenCalled();
    connected.bridge.clear();
    connected.childPort.close();
  });

  it("retires the prior tab port before granting the replacement tab capabilities", async () => {
    const connected = await connectBridge({ sessionActions: ["save"] });
    const replacementRequest = vi.fn(async () => ({ ok: true }));
    connected.bridge.sync({
      frame: connected.frame,
      key: "calendar/settings",
      nonce: "calendar-nonce",
      pluginId: "calendar",
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      connected: true,
      sessionKey: "agent:main:replacement",
      sessionActions: ["save"],
      allowChatNavigation: false,
      navigateToChat: vi.fn(),
    });

    connected.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "retired-save",
      actionId: "save",
      contextRevision: 1,
    });
    const earlyReplacement = offerBridgePort(connected.frame, "calendar-nonce");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(earlyReplacement.messages).toEqual([]);

    connected.frame.dispatchEvent(new Event("load"));
    const replacement = offerBridgePort(connected.frame, "calendar-nonce");
    await vi.waitFor(() => expect(replacement.messages).toHaveLength(1));
    expect(replacement.messages[0]).toMatchObject({
      v: 1,
      type: "openclaw.pluginUi.connect",
      capabilities: { sessionActions: ["save"], navigateToChat: false },
      context: { sessionKey: "agent:main:replacement", revision: 1 },
    });
    replacement.childPort.postMessage({
      v: 1,
      type: "openclaw.pluginUi.sessionAction",
      id: "replacement-save",
      actionId: "save",
      contextRevision: 1,
    });
    await vi.waitFor(() =>
      expect(replacementRequest).toHaveBeenCalledWith("plugins.sessionAction", {
        pluginId: "calendar",
        actionId: "save",
        sessionKey: "agent:main:replacement",
      }),
    );
    connected.bridge.clear();
    connected.childPort.close();
    earlyReplacement.childPort.close();
    replacement.childPort.close();
  });
});
