import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWidget, WidgetManifestView } from "../lib/workspace/types.ts";
import {
  attachWidgetBridge,
  loadWidgetManifestView,
  renderCustomWidgetHost,
  widgetAssetUrl,
  type CustomWidgetHostContext,
} from "./workspace-custom-widget.ts";

const BRIDGE_TOKEN = "11111111-1111-4111-8111-111111111111";
const FRAME_EXPIRES_AT = Date.now() + 60 * 60 * 1000;

function widget(overrides: Partial<WorkspaceWidget> = {}): WorkspaceWidget {
  return {
    id: "w_custom",
    kind: "custom:revenue-chart",
    title: "Revenue Chart",
    grid: { x: 0, y: 0, w: 6, h: 4 },
    collapsed: false,
    bindings: { value: { source: "static", value: { revenue: 42 } } },
    ...overrides,
  };
}

function manifest(overrides?: Partial<WidgetManifestView>): WidgetManifestView {
  return {
    name: "revenue-chart",
    frameToken: BRIDGE_TOKEN,
    entrypoint: "index.html",
    bindings: { value: { source: "static", value: null } },
    capabilities: ["data:read"],
    ...overrides,
  };
}

function host(overrides?: Partial<CustomWidgetHostContext>): CustomWidgetHostContext {
  return { client: null, basePath: "", sessionKey: "main", ...overrides };
}

function renderToContainer(template: unknown): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(template as never, container);
  return container;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("widgetAssetUrl", () => {
  it("builds a URL under the plugin route with encoded segments", () => {
    expect(widgetAssetUrl("", BRIDGE_TOKEN, "revenue-chart", "index.html")).toBe(
      `/plugins/workspaces/widgets/${BRIDGE_TOKEN}/revenue-chart/index.html`,
    );
    expect(widgetAssetUrl("/base", "token value", "a b", "assets/app.js")).toBe(
      "/base/plugins/workspaces/widgets/token%20value/a%20b/assets/app.js",
    );
  });
});

describe("loadWidgetManifestView", () => {
  it("shapes an authenticated frame response into the bridge read model", async () => {
    const request = vi.fn(async () => ({
      frameToken: BRIDGE_TOKEN,
      frameExpiresAt: FRAME_EXPIRES_AT,
      manifest: {
        entrypoint: "index.html",
        bindings: [{ id: "value", source: "static", value: 1 }],
        capabilities: ["data:read", "prompt:send"],
      },
    }));
    const view = await loadWidgetManifestView({ request } as never, "revenue-chart");
    expect(view).toEqual({
      name: "revenue-chart",
      frameToken: BRIDGE_TOKEN,
      frameExpiresAt: FRAME_EXPIRES_AT,
      entrypoint: "index.html",
      bindings: { value: { source: "static", value: 1 } },
      capabilities: ["data:read", "prompt:send"],
    });
  });

  it("returns null when the authenticated frame request fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await loadWidgetManifestView({ request } as never, "revenue-chart")).toBeNull();
  });

  it("drops prototype-setter binding ids", async () => {
    const request = vi.fn(async () => ({
      frameToken: BRIDGE_TOKEN,
      frameExpiresAt: FRAME_EXPIRES_AT,
      manifest: {
        entrypoint: "index.html",
        bindings: [{ id: "__proto__", source: "static", value: 1 }],
        capabilities: ["data:read"],
      },
    }));

    const view = await loadWidgetManifestView({ request } as never, "revenue-chart");
    expect(Object.keys(view?.bindings ?? {})).toEqual([]);
  });
});

describe("renderCustomWidgetHost DOM", () => {
  it("renders an iframe whose sandbox is exactly allow-scripts", () => {
    const container = renderToContainer(
      renderCustomWidgetHost({ widget: widget(), manifest: manifest(), context: host() }),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // The sandbox attribute is a CONSTANT — exactly "allow-scripts", nothing else.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    const tokens = (iframe?.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["allow-scripts"]);
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-forms");
    expect(tokens).not.toContain("allow-popups");
    expect(tokens).not.toContain("allow-top-navigation");
  });

  it("sets referrerpolicy=no-referrer and the served src", () => {
    const container = renderToContainer(
      renderCustomWidgetHost({
        widget: widget(),
        manifest: manifest(),
        context: host({ basePath: "/gw" }),
      }),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.getAttribute("src")).toMatch(
      new RegExp(`^/gw/plugins/workspaces/widgets/${BRIDGE_TOKEN}/revenue-chart/index\\.html$`),
    );
  });
});

function connectWidgetBridge(params: {
  iframe: HTMLIFrameElement;
  widget?: WorkspaceWidget;
  manifest?: WidgetManifestView;
  context?: CustomWidgetHostContext;
}): { childPort: MessagePort; detach: () => void; posts: unknown[] } {
  const channel = new MessageChannel();
  const posts: unknown[] = [];
  channel.port1.addEventListener("message", (event) => posts.push(event.data));
  channel.port1.start();
  const detach = attachWidgetBridge({
    iframe: params.iframe,
    widget: params.widget ?? widget(),
    manifest: params.manifest ?? manifest(),
    context: params.context ?? host(),
    bridgeToken: BRIDGE_TOKEN,
  });
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { v: 1, type: "workspace:bridge:init", token: BRIDGE_TOKEN },
      source: params.iframe.contentWindow,
      ports: [channel.port2],
    }),
  );
  return { childPort: channel.port1, detach, posts };
}

describe("attachWidgetBridge document-bound channel", () => {
  it("drops a foreign bootstrap and accepts the iframe's token-bound port", async () => {
    const iframe = document.createElement("iframe");
    const foreign = document.createElement("iframe");
    document.body.append(iframe, foreign);
    const foreignChannel = new MessageChannel();
    const detach = attachWidgetBridge({
      iframe,
      widget: widget(),
      manifest: manifest(),
      context: host(),
      bridgeToken: BRIDGE_TOKEN,
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:bridge:init", token: BRIDGE_TOKEN },
        source: foreign.contentWindow,
        ports: [foreignChannel.port2],
      }),
    );

    const channel = new MessageChannel();
    const posts: unknown[] = [];
    channel.port1.addEventListener("message", (event) => posts.push(event.data));
    channel.port1.start();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:bridge:init", token: BRIDGE_TOKEN },
        source: iframe.contentWindow,
        ports: [channel.port2],
      }),
    );
    channel.port1.postMessage(
      {
        v: 1,
        type: "workspace:getData",
        requestId: "r2",
        bindingId: "value",
      },
      [],
    );

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ type: "workspace:data", requestId: "r2", bindingId: "value" });
    foreignChannel.port1.close();
    channel.port1.close();
    detach();
  });

  it("sends an approved prompt with a gateway idempotency key", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const request = vi.fn(async (_method: string, _params: unknown) => ({
      runId: "run-1",
      status: "started",
    }));
    const { childPort, detach } = connectWidgetBridge({
      iframe,
      manifest: manifest({ name: "prompt-send-test", capabilities: ["prompt:send"] }),
      context: host({ client: { request } as never, confirmPrompt: () => true }),
    });

    childPort.postMessage(
      {
        v: 1,
        type: "workspace:sendPrompt",
        requestId: "r1",
        text: "Summarize this workspace",
      },
      [],
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "main",
      message: "Summarize this workspace",
      deliver: false,
      idempotencyKey: expect.any(String),
    });
    const payload = request.mock.calls[0]?.[1] as { idempotencyKey?: string } | undefined;
    expect(payload?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    detach();
  });

  it("closes the document port on detach", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const { childPort, detach, posts } = connectWidgetBridge({ iframe });
    detach();
    childPort.postMessage(
      {
        v: 1,
        type: "workspace:getData",
        requestId: "r1",
        bindingId: "value",
      },
      [],
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(posts).toHaveLength(0);
    childPort.close();
  });

  it("never accepts a replacement document's second bootstrap", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const { childPort, detach } = connectWidgetBridge({ iframe });
    const replacement = new MessageChannel();
    const replacementPosts: unknown[] = [];
    replacement.port1.addEventListener("message", (event) => replacementPosts.push(event.data));
    replacement.port1.start();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:bridge:init", token: BRIDGE_TOKEN },
        source: iframe.contentWindow,
        ports: [replacement.port2],
      }),
    );
    replacement.port1.postMessage(
      {
        v: 1,
        type: "workspace:getData",
        requestId: "replacement",
        bindingId: "value",
      },
      [],
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(replacementPosts).toHaveLength(0);
    childPort.close();
    replacement.port1.close();
    detach();
  });
});

describe("attachWidgetBridge privileged-data boundary", () => {
  it("denies an rpc binding without calling the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const request = vi.fn(async () => ({ leaked: true }));
    const { childPort, detach, posts } = connectWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "rpc", method: "sessions.delete" } } }),
      manifest: manifest({
        bindings: { value: { source: "rpc", method: "sessions.delete" } },
      }),
      context: host({ client: { request } as never }),
    });
    childPort.postMessage(
      { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
      [],
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("denies an allowlisted rpc binding without calling the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const request = vi.fn(async () => ({ sessions: [] }));
    const { childPort, detach, posts } = connectWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "rpc", method: "sessions.list" } } }),
      manifest: manifest({ bindings: { value: { source: "rpc", method: "sessions.list" } } }),
      context: host({ client: { request } as never }),
    });
    childPort.postMessage(
      { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
      [],
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("denies a file binding without reading through the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const request = vi.fn(async () => ({ secret: true }));
    const { childPort, detach, posts } = connectWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "file", path: "private.json" } } }),
      manifest: manifest({ bindings: { value: { source: "file", path: "private.json" } } }),
      context: host({ client: { request } as never }),
    });
    childPort.postMessage(
      { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
      [],
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("refuses a manifest with no entrypoint", async () => {
    // The approval gate hashes the declared entrypoint; without one there is no
    // approved file to load, so nothing should mount.
    const request = vi.fn(async () => ({
      frameToken: BRIDGE_TOKEN,
      frameExpiresAt: FRAME_EXPIRES_AT,
      manifest: { bindings: [], capabilities: [] },
    }));

    expect(await loadWidgetManifestView({ request } as never, "revenue-chart")).toBeNull();
  });
});
