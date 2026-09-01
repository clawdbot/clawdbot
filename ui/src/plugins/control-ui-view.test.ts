import { html, LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiHost, ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { renderPluginSurface } from "./control-ui-view.ts";

class SurfaceTestHost extends LitElement {
  count = 0;
  sessionKey = "main";
  readonly navigation = document.createElement("nav");
  override createRenderRoot() {
    return this;
  }
  increment() {
    this.count += 1;
  }
  override render() {
    return renderPluginSurface(
      "workspace",
      { sessionKey: this.sessionKey, routeId: "chat" },
      html`<button class="builtin-action" @click=${this.increment}>Built-in action</button> ${this
          .navigation}`,
    );
  }
}
customElements.define("control-ui-surface-test-host", SurfaceTestHost);

function mountSurface(initial?: ControlUiReplacement<"workspace">) {
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const pluginHost = {
    signal: abort.signal,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  let selected = initial;
  const context = {
    plugins: {
      selectedReplacement: () =>
        selected
          ? {
              key: "review/composed",
              pluginId: "review",
              value: selected,
              host: pluginHost,
              signal: abort.signal,
            }
          : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reportError: vi.fn(),
    },
  } as unknown as ApplicationContext<RouteId>;
  const provider = createApplicationContextProvider(context);
  const host = document.createElement("control-ui-surface-test-host") as SurfaceTestHost;
  provider.append(host);
  document.body.append(provider);
  return {
    host,
    provider,
    context,
    listeners,
    select(replacement?: ControlUiReplacement<"workspace">) {
      selected = replacement;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("native UI built-in delegation", () => {
  it("restores retained navigation when a workspace replacement's final update is pending", async () => {
    const { host, select } = mountSurface();
    const navigate = vi.fn();
    const link = document.createElement("button");
    link.textContent = "Open plugin page";
    link.onclick = navigate;
    host.navigation.append(link);
    await host.updateComplete;

    select({
      id: "workspace",
      label: "Custom workspace",
      surface: "workspace",
      mount(container) {
        container.textContent = "Custom workspace";
      },
    });
    await vi.waitFor(() => expect(host.textContent).toBe("Custom workspace"));
    const retired = host.querySelector<LitElement>("openclaw-plugin-view")!;
    expect(link.isConnected).toBe(false);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    await retired.updateComplete;
    expect(host.querySelector("nav")).toBe(host.navigation);
    expect(link.isConnected).toBe(true);
    link.click();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the built-in synchronous and preserves its event receiver through composition and failure recovery", async () => {
    const dispose = vi.fn();
    const replacement: ControlUiReplacement<"workspace"> = {
      id: "composed",
      label: "Composed workspace",
      surface: "workspace",
      mount(container, context) {
        const stop = context.mountDefault(container);
        return {
          dispose() {
            dispose();
            stop();
          },
        };
      },
    };
    const { host, context, listeners, select } = mountSurface();
    await host.updateComplete;
    expect(host.querySelector("openclaw-plugin-view")).toBeNull();
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(1);

    select(replacement);
    await vi.waitFor(() =>
      expect(host.querySelector("openclaw-plugin-view button")).not.toBeNull(),
    );
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(2);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(3);
    expect(dispose).toHaveBeenCalledOnce();
    expect(context.plugins.reportError).not.toHaveBeenCalled();

    const failure = new Error("Plugin mount failed");
    select({
      ...replacement,
      mount() {
        throw failure;
      },
    });
    await vi.waitFor(() =>
      expect(host.querySelector("[role=alert]")?.textContent).toContain(failure.message),
    );
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(4);
    expect(context.plugins.reportError).toHaveBeenCalledWith("review", failure);
    host.remove();
    expect(listeners.size).toBe(0);
  });

  it("gives append-only views fresh roots across replacement, session changes, and reconnection", async () => {
    const roots: HTMLElement[] = [];
    const signals: AbortSignal[] = [];
    const replacement: ControlUiReplacement<"workspace"> = {
      id: "append-only",
      label: "Append-only workspace",
      surface: "workspace",
      mount(container, context) {
        roots.push(container);
        signals.push(context.signal);
        container.append(document.createTextNode("Plugin content"));
      },
    };
    const { host, provider, listeners, select } = mountSurface(replacement);
    await vi.waitFor(() => expect(roots).toHaveLength(1));
    select({ ...replacement });
    await vi.waitFor(() => expect(roots).toHaveLength(2));
    expect(roots[1]).not.toBe(roots[0]);
    expect(signals[0]?.aborted).toBe(true);
    expect(host.textContent).toBe("Plugin content");

    host.sessionKey = "other-session";
    host.requestUpdate();
    await vi.waitFor(() => expect(roots).toHaveLength(3));
    expect(roots[2]).not.toBe(roots[1]);
    expect(signals[1]?.aborted).toBe(true);
    expect(host.textContent).toBe("Plugin content");

    host.remove();
    expect(signals[2]?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    const view = host.querySelector<LitElement>("openclaw-plugin-view")!;
    view.requestUpdate();
    await view.updateComplete;
    expect(roots).toHaveLength(3);
    provider.append(host);
    await vi.waitFor(() => expect(roots).toHaveLength(4));
    expect(roots[3]).not.toBe(roots[2]);
    expect(signals[3]?.aborted).toBe(false);
    expect(host.textContent).toBe("Plugin content");
  });
});
