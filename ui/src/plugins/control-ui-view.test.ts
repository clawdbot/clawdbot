import { html, LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { renderPluginSurface } from "./control-ui-view.ts";
import "./control-ui-view.runtime.ts";

function increment(this: SurfaceTestHost) {
  this.count += 1;
}

class SurfaceTestHost extends LitElement {
  count = 0;
  sessionKey = "main";
  agentId = "main";
  surface: "workspace" | "composer" = "workspace";
  draft = "";
  readonly setDraft = vi.fn((draft: string) => {
    this.draft = draft;
  });
  readonly send = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  readonly abort = vi.fn();
  readonly navigation = document.createElement("nav");
  override createRenderRoot() {
    return this;
  }
  override render() {
    const identity = { sessionKey: this.sessionKey, agentId: this.agentId };
    const defaultView = html`<button class="builtin-action" @click=${increment}>
        Built-in action
      </button>
      ${this.navigation}`;
    if (this.surface === "composer") {
      return renderPluginSurface(
        "composer",
        {
          ...identity,
          draft: this.draft,
          canSend: true,
          sending: false,
          disabledReason: null,
          setDraft: this.setDraft,
          send: this.send,
          abort: this.abort,
        },
        defaultView,
      );
    }
    return renderPluginSurface("workspace", { ...identity, routeId: "chat" }, defaultView);
  }
}
customElements.define("control-ui-surface-test-host", SurfaceTestHost);

function mountSurface(initial?: ControlUiReplacement<"workspace" | "composer">) {
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const request = vi.fn().mockResolvedValue({ ok: true });
  const pluginHost = {
    signal: abort.signal,
    request,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const reportError = vi.fn();
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
      reportError,
    },
  } as unknown as ApplicationContext<RouteId>;
  const provider = createApplicationContextProvider(context);
  const host = document.createElement("control-ui-surface-test-host") as SurfaceTestHost;
  host.surface = initial?.surface ?? "workspace";
  provider.append(host);
  document.body.append(provider);
  return {
    host,
    provider,
    reportError,
    listeners,
    request,
    select: (replacement?: ControlUiReplacement<"workspace" | "composer">) => {
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
  it.each([
    { label: "another agent", nextAgents: ["writer"] },
    { label: "the original agent after a same-turn switch", nextAgents: ["writer", "main"] },
    { label: "the same replacement after a same-turn deselection" },
  ])("retires composer callbacks before rendering $label", async ({ nextAgents }) => {
    const contexts: ControlUiViewContext<ControlUiSurfaceProps["composer"]>[] = [];
    const roots: HTMLElement[] = [];
    const dispose = vi.fn();
    const replacement: ControlUiReplacement<"composer"> = {
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount(container, context) {
        contexts.push(context);
        roots.push(container);
        container.textContent = context.props.agentId;
        return { dispose };
      },
    };
    const { host, request, select } = mountSurface(replacement);
    host.sessionKey = "global";
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    const current = contexts[0];
    const view = host.querySelector<LitElement & { props: ControlUiSurfaceProps["composer"] }>(
      "openclaw-plugin-view",
    );
    if (!current || !view) {
      throw new Error("Expected the composer replacement to mount");
    }
    current.props.setDraft("Current draft");
    expect(host.draft).toBe("Current draft");

    if (nextAgents) {
      const props = view.props;
      for (const agentId of nextAgents) {
        view.props = { ...props, agentId };
      }
    } else {
      select();
      select(replacement);
    }
    // Revocation precedes the queued render; DOM disposal belongs to that render.
    expect(dispose).not.toHaveBeenCalled();
    expect(() => current.props.setDraft("Stale draft")).toThrow("view has ended");
    expect(current.signal.aborted).toBe(true);
    expect(host.draft).toBe("Current draft");
    await expect(current.host.request("fixture.retired-view")).rejects.toThrow("view has ended");
    expect(request).not.toHaveBeenCalled();

    await view.updateComplete;
    expect(dispose).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(roots[1]).not.toBe(roots[0]);
    const successor = contexts[1];
    if (!successor) {
      throw new Error("Expected a new composer owner to mount");
    }
    expect(successor.props.agentId).toBe(nextAgents?.at(-1) ?? "main");
    successor.props.setDraft("Successor draft");
    expect(host.draft).toBe("Successor draft");
  });

  it.each([false, true])(
    "retires hidden composer operations while retaining the view (same-turn return: %s)",
    async (sameTurnReturn) => {
      const contexts: ControlUiViewContext<ControlUiSurfaceProps["composer"]>[] = [];
      const roots: HTMLElement[] = [];
      const dispose = vi.fn();
      const replacement: ControlUiReplacement<"composer"> = {
        id: "composer",
        label: "Custom composer",
        surface: "composer",
        mount(container, context) {
          contexts.push(context);
          roots.push(container);
          container.textContent = "Retained local view state";
          return { update: (next) => contexts.push(next), dispose };
        },
      };
      const { host, request } = mountSurface(replacement);
      await vi.waitFor(() => expect(roots).toHaveLength(1));
      const current = contexts.at(-1);
      const view = host.querySelector<LitElement & { presented: boolean }>("openclaw-plugin-view");
      if (!current || !view) {
        throw new Error("Expected the composer replacement to mount");
      }
      current.props.setDraft("Current draft");
      const send = createDeferred<boolean>();
      host.send.mockReturnValueOnce(send.promise);
      const pending = expect(current.props.send()).rejects.toThrow("view has ended");

      view.presented = false;
      // Presentation retires operations synchronously without retiring the mounted host.
      expect(() => current.props.setDraft("Stale draft")).toThrow("view has ended");
      expect(() => current.props.abort?.()).toThrow("view has ended");
      const hiddenSend = expect(current.props.send()).rejects.toThrow("view has ended");
      expect(current.signal.aborted).toBe(false);
      expect(host.send).toHaveBeenCalledOnce();
      expect(host.abort).not.toHaveBeenCalled();
      expect(host.draft).toBe("Current draft");

      if (sameTurnReturn) {
        view.presented = true;
      }
      await hiddenSend;
      if (!sameTurnReturn) {
        await view.updateComplete;
        const hidden = contexts.at(-1);
        expect(hidden?.presented).toBe(false);
        expect(() => hidden?.props.setDraft("Hidden draft")).toThrow("view has ended");
      }
      view.presented = true;
      expect(() => current.props.setDraft("Revived draft")).toThrow("view has ended");
      send.resolve(true);
      await pending;
      await view.updateComplete;

      expect(roots).toHaveLength(1);
      expect(view.querySelector("[data-plugin-view-root]")).toBe(roots[0]);
      expect(roots[0]?.textContent).toBe("Retained local view state");
      expect(dispose).not.toHaveBeenCalled();
      await expect(current.host.request("fixture.retained-view")).resolves.toEqual({ ok: true });
      expect(request).toHaveBeenCalledOnce();
      const successor = contexts.at(-1);
      if (!successor || successor === current) {
        throw new Error("Expected fresh composer operations on return");
      }
      expect(successor.presented).toBe(true);
      expect(successor.signal).toBe(current.signal);
      successor.props.setDraft("Successor draft");
      expect(host.draft).toBe("Successor draft");
      await expect(successor.props.send()).resolves.toBe(true);
      successor.props.abort?.();
      expect(host.abort).toHaveBeenCalledOnce();
      expect(() => current.props.setDraft("Still retired")).toThrow("view has ended");
    },
  );

  it("restores retained navigation when a workspace replacement's final update is pending", async () => {
    const { host, select } = mountSurface();
    const navigate = vi.fn();
    const link = document.createElement("button");
    link.textContent = "Open plugin page";
    link.addEventListener("click", navigate);
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
    const { host, reportError, listeners, select } = mountSurface();
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
    expect(reportError).not.toHaveBeenCalled();

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
    expect(reportError).toHaveBeenCalledWith("review", failure);
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
