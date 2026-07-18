import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { WIDGET_PROMPT_EVENT, type WidgetPromptEventDetail } from "./mcp-app-security.ts";

const bridgeMocks = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));

vi.mock("@modelcontextprotocol/ext-apps/app-bridge", () => {
  class AppBridge {
    oninitialized?: () => void;
    messageHandler?: (params: {
      role: "user";
      content: Array<{ type: string; text?: string }>;
    }) => Promise<{ isError?: boolean }>;
    onsizechange?: (params: { height?: number }) => void;
    setHostContext = vi.fn();
    teardownResource = vi.fn(async () => ({}));
    sendSandboxResourceReady = vi.fn(async () => undefined);
    sendToolInput = vi.fn(async () => undefined);
    sendToolResult = vi.fn(async () => undefined);

    constructor(
      _client: unknown,
      _hostInfo: unknown,
      public capabilities: Record<string, unknown>,
      public options: Record<string, unknown>,
    ) {
      bridgeMocks.instances.push(this as unknown as Record<string, unknown>);
    }

    set onmessage(handler: NonNullable<AppBridge["messageHandler"]>) {
      this.messageHandler = handler;
    }

    protected replaceRequestHandler() {}

    async connect() {
      this.oninitialized?.();
    }
  }

  class PostMessageTransport {
    async close() {}
  }

  return { AppBridge, PostMessageTransport };
});

const { McpAppView } = await import("./mcp-app-view.ts");
type McpAppViewElement = InstanceType<typeof McpAppView>;

const MCP_APP_VIEW_ELEMENT_NAME = `test-mcp-app-view-${crypto.randomUUID()}`;

// Keep the mounted view and i18n controller in the current module graph when
// the non-isolated runner has retained an earlier production registration.
class TestMcpAppView extends McpAppView {}

customElements.define(MCP_APP_VIEW_ELEMENT_NAME, TestMcpAppView);

describe("mcp-app-view localization", () => {
  afterEach(async () => {
    bridgeMocks.instances.length = 0;
    document.body.replaceChildren();
    delete (document as unknown as Record<string, unknown>).activeElement;
    delete document.documentElement.dataset.themeMode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  async function mountBridge(viewId: string, messageSupported = true) {
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(window);
    const messageListeners: EventListenerOrEventListenerObject[] = [];
    const addEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "message") {
        messageListeners.push(listener);
      }
      addEventListener(type, listener, options);
    });
    const themeListeners = new Set<() => void>();
    const unsubscribe = vi.fn();
    const request = vi.fn(async () => ({
      sandboxUrl: "/mcp-app-sandbox?ticket=test",
      sandboxPort: 8444,
      html: "<!doctype html><button>Send</button>",
      toolInput: {},
      toolResult: { content: [{ type: "text", text: "ready" }] },
      messageSupported,
    }));
    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    Reflect.set(view, "context", {
      gateway: {
        snapshot: { client: { request } },
        connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
      },
      theme: {
        subscribe(listener: () => void) {
          themeListeners.add(listener);
          return () => {
            themeListeners.delete(listener);
            unsubscribe();
          };
        },
      },
    });
    view.sessionKey = "agent:main:main";
    view.viewId = viewId;
    document.body.append(view);

    await expect.poll(() => view.shadowRoot?.querySelector("iframe")).not.toBeNull();
    const frame = view.shadowRoot!.querySelector("iframe")!;
    await expect.poll(() => frame.getAttribute("src")).toContain("/mcp-app-sandbox?ticket=test");
    const readyEvent = {
      data: { method: "ui/notifications/sandbox-proxy-ready" },
      source: frame.contentWindow,
    } as MessageEvent;
    expect(messageListeners.length).toBeGreaterThan(0);
    expect(readyEvent.source).toBe(frame.contentWindow);
    for (const readyListener of messageListeners) {
      if (typeof readyListener === "function") {
        readyListener.call(window, readyEvent);
      } else {
        readyListener.handleEvent(readyEvent);
      }
    }
    await expect.poll(() => bridgeMocks.instances.length).toBe(1);
    return {
      bridge: bridgeMocks.instances[0] as {
        capabilities: Record<string, unknown>;
        options: { hostContext?: Record<string, unknown> };
        messageHandler?: (params: {
          role: "user";
          content: Array<{ type: string; text?: string }>;
        }) => Promise<{ isError?: boolean }>;
        setHostContext: ReturnType<typeof vi.fn>;
      },
      frame,
      request,
      themeListeners,
      unsubscribe,
      view,
    };
  }

  it("accepts only focused visible plain-text ui/message requests through the chat seam", async () => {
    const { bridge, frame, view } = await mountBridge(`view-message-${crypto.randomUUID()}`);
    expect(bridge.capabilities).toMatchObject({ message: { text: {} } });
    expect(bridge.messageHandler).toBeTypeOf("function");

    const received: string[] = [];
    view.addEventListener(WIDGET_PROMPT_EVENT, (event: Event) => {
      received.push((event as CustomEvent<WidgetPromptEventDetail>).detail.text);
    });
    const send = async (content: Array<{ type: string; text?: string }>) =>
      await bridge.messageHandler!({ role: "user", content });

    expect(await send([{ type: "text", text: "Background send" }])).toEqual({ isError: true });
    (frame as HTMLIFrameElement & { checkVisibility: () => boolean }).checkVisibility = () => false;
    Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
    expect(await send([{ type: "text", text: "Hidden send" }])).toEqual({ isError: true });

    (frame as HTMLIFrameElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await send([{ type: "text", text: "Needs approval" }])).toEqual({ isError: true });
    expect(confirm).toHaveBeenLastCalledWith("Confirm:\n\nNeeds approval");
    confirm.mockReturnValue(true);
    expect(await send([{ type: "text", text: "  Show details  " }])).toEqual({});
    expect(received).toEqual(["Show details"]);

    for (const content of [
      [{ type: "text", text: "/approve" }],
      [{ type: "text", text: "   " }],
      [{ type: "text", text: "x".repeat(4_001) }],
      [{ type: "image" }],
      [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    ]) {
      expect(await send(content)).toEqual({ isError: true });
    }

    for (let index = 2; index <= 9; index += 1) {
      expect(await send([{ type: "text", text: `Prompt ${index}` }])).toEqual({});
    }
    expect(await send([{ type: "text", text: "Prompt 10" }])).toEqual({ isError: true });
    expect(received).toHaveLength(9);
  });

  it("does not advertise or install message support for read-only views", async () => {
    const { bridge } = await mountBridge(`view-read-only-${crypto.randomUUID()}`, false);
    expect(bridge.capabilities).not.toHaveProperty("message");
    expect(bridge.messageHandler).toBeUndefined();
  });

  it("pushes live theme and container changes and cleans up their observers", async () => {
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    let width = 640;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width }) as DOMRect,
    );
    document.documentElement.dataset.themeMode = "dark";

    const { bridge, themeListeners, unsubscribe, view } = await mountBridge(
      `view-context-${crypto.randomUUID()}`,
    );
    expect(bridge.options.hostContext).toMatchObject({
      theme: "dark",
      containerDimensions: { width: 640, height: 600 },
    });
    await expect.poll(() => themeListeners.size).toBe(1);

    document.documentElement.dataset.themeMode = "light";
    themeListeners.values().next().value?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "light" }),
    );

    width = 720;
    resize?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ containerDimensions: { width: 720, height: 600 } }),
    );

    view.remove();
    await expect.poll(() => disconnect).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(themeListeners.size).toBe(0);
  });

  it("renders gateway failures with localized copy", async () => {
    i18n.registerTranslation("pt-BR", {
      mcpApp: {
        title: "Aplicativo MCP",
        unavailable: "Aplicativo MCP indisponível: {error}",
      },
    });
    await i18n.setLocale("pt-BR");

    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
    view.sessionKey = "agent:main:main";
    view.viewId = "view-1";
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: MCP App gateway unavailable");
  });

  it.each([
    ["foreign origin", "https://attacker.example/mcp-app-sandbox", 8444, undefined],
    ["data URL", "data:text/html;base64,cHJveHk=", 8444, undefined],
    ["same gateway port", "/mcp-app-sandbox", 8443, undefined],
    ["host origin", "/mcp-app-sandbox", 8444, "host"],
  ])(
    "rejects a %s sandbox URL through the mounted view",
    async (_label, sandboxUrl, sandboxPort, sandboxOrigin) => {
      const resolvedSandboxOrigin =
        sandboxOrigin === "host" ? window.location.origin : sandboxOrigin;
      const request = vi.fn(async () => ({
        sandboxUrl,
        sandboxPort,
        ...(resolvedSandboxOrigin ? { sandboxOrigin: resolvedSandboxOrigin } : {}),
        html: "<p>unsafe</p>",
        toolInput: null,
        toolResult: null,
      }));
      const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppViewElement;
      Reflect.set(view, "context", {
        gateway: {
          snapshot: { client: { request } },
          connection: { gatewayUrl: "ws://gateway.example:8443/openclaw" },
        },
      });
      view.sessionKey = "agent:main:main";
      view.viewId = crypto.randomUUID();
      document.body.append(view);

      await expect
        .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
        .toContain("MCP App sandbox URL is invalid");
      expect(view.shadowRoot?.querySelector("iframe")).toBeNull();
    },
  );
});
