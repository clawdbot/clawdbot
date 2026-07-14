import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWidget, WidgetManifestView } from "../lib/workspace/types.ts";
import {
  loadWidgetManifestView,
  renderCustomWidgetHost,
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

function connectRenderedWidget(params: {
  widget?: WorkspaceWidget;
  manifest?: WidgetManifestView;
  context?: CustomWidgetHostContext;
}) {
  const container = renderToContainer(
    renderCustomWidgetHost({
      widget: params.widget ?? widget(),
      manifest: params.manifest ?? manifest(),
      context: params.context ?? host(),
    }),
  );
  const iframe = container.querySelector("iframe");
  if (!iframe) {
    throw new Error("expected custom widget iframe");
  }
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
  return {
    childPort: channel.port1,
    container,
    iframe,
    posts,
    disconnect: () => render(nothing, container),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
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

  it("refuses a manifest without the approved entrypoint", async () => {
    const request = vi.fn(async () => ({
      frameToken: "test-token-placeholder",
      frameExpiresAt: FRAME_EXPIRES_AT,
      manifest: {
        bindings: [{ id: "value", source: "static", value: 1 }],
        capabilities: ["data:read"],
      },
    }));

    expect(await loadWidgetManifestView({ request } as never, "revenue-chart")).toBeNull();
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

describe("renderCustomWidgetHost bridge", () => {
  it("drops a foreign bootstrap and accepts only its iframe document", async () => {
    const container = renderToContainer(
      renderCustomWidgetHost({ widget: widget(), manifest: manifest(), context: host() }),
    );
    const iframe = container.querySelector("iframe");
    if (!iframe) {
      throw new Error("expected custom widget iframe");
    }
    const foreign = document.createElement("iframe");
    document.body.append(foreign);
    const foreignChannel = new MessageChannel();
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
    channel.port1.postMessage({
      v: 1,
      type: "workspace:getData",
      requestId: "r2",
      bindingId: "value",
    });

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      type: "workspace:data",
      requestId: "r2",
      bindingId: "value",
    });
    channel.port1.close();
    foreignChannel.port1.close();
    render(nothing, container);
  });

  it("sends an approved prompt with a gateway idempotency key", async () => {
    const request = vi.fn(async () => ({ runId: "run-1", status: "started" }));
    const connected = connectRenderedWidget({
      manifest: manifest({ name: "prompt-send-test", capabilities: ["prompt:send"] }),
      context: host({ client: { request } as never, confirmPrompt: () => true }),
    });
    connected.childPort.postMessage(
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
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    connected.childPort.close();
    connected.disconnect();
  });

  it("closes the document port when the rendered widget detaches", async () => {
    const connected = connectRenderedWidget({});
    connected.disconnect();
    connected.childPort.postMessage(
      {
        v: 1,
        type: "workspace:getData",
        requestId: "after-detach",
        bindingId: "value",
      },
      [],
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(connected.posts).toEqual([]);
    connected.childPort.close();
  });

  it("rejects a second bootstrap for the same iframe document", async () => {
    const connected = connectRenderedWidget({});
    const replacementInit = Object.fromEntries([
      ["v", 1],
      ["type", "workspace:bridge:init"],
      ["token", BRIDGE_TOKEN],
    ]);
    const replacement = new MessageChannel();
    const replacementPosts: unknown[] = [];
    replacement.port1.addEventListener("message", (event) => replacementPosts.push(event.data));
    replacement.port1.start();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: replacementInit,
        source: connected.iframe.contentWindow,
        ports: [replacement.port2],
      }),
    );
    replacement.port1.postMessage({
      v: 1,
      type: "workspace:getData",
      requestId: "replacement",
      bindingId: "value",
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(replacementPosts).toEqual([]);
    replacement.port1.close();
    connected.childPort.close();
    connected.disconnect();
  });

  it.each([
    [{ source: "rpc", method: "sessions.delete" } as const],
    [{ source: "rpc", method: "sessions.list" } as const],
    [{ source: "file", path: "private.json" } as const],
  ])("denies privileged binding %o without calling the gateway", async (binding) => {
    const request = vi.fn(async () => ({ leaked: true }));
    const connected = connectRenderedWidget({
      widget: widget({ bindings: { value: binding } }),
      manifest: manifest({ bindings: { value: binding } }),
      context: host({ client: { request } as never }),
    });
    connected.childPort.postMessage(
      {
        v: 1,
        type: "workspace:getData",
        requestId: "r1",
        bindingId: "value",
      },
      [],
    );

    await vi.waitFor(() => expect(connected.posts.length).toBeGreaterThan(0));
    expect(connected.posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    connected.childPort.close();
    connected.disconnect();
  });
});
