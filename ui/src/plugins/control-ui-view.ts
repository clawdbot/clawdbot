import { ContextConsumer } from "@lit/context";
import { html, LitElement, nothing, type ChildPart } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
} from "../../../src/plugin-sdk/control-ui.js";
import { applicationContext } from "../app/context.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

export type ViewKind = "pages" | "panels" | "accessories" | "widgets" | "replacements";

class PluginSurfaceDirective extends AsyncDirective {
  private host?: LitElement;
  private consumer?: ContextConsumer<typeof applicationContext, LitElement>;
  private runtime?: ControlUiPluginCapability;
  private unsubscribe?: () => void;
  private args?: [ControlUiSurface, unknown, unknown, boolean];
  private pending = false;

  override update(part: ChildPart, args: [ControlUiSurface, unknown, unknown, boolean]) {
    this.args = args;
    const host = part.options?.host;
    if (host instanceof LitElement && this.host !== host) {
      this.disconnect();
      this.host = host;
    }
    this.connect();
    return this.render(...args);
  }

  private connect() {
    if (!this.isConnected || !this.host || this.consumer) {
      return;
    }
    this.consumer = new ContextConsumer(this.host, {
      context: applicationContext,
      subscribe: true,
      callback: (context) => {
        if (this.runtime === context?.plugins) {
          return;
        }
        this.unsubscribe?.();
        this.runtime = context?.plugins;
        this.unsubscribe = this.runtime?.subscribe(() => this.refresh());
        this.refresh();
      },
    });
  }

  private refresh() {
    if (this.pending) {
      return;
    }
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.isConnected && this.args) {
        this.setValue(this.render(...this.args));
      }
    });
  }

  private disconnect() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.consumer?.hostDisconnected();
    if (this.consumer) {
      this.host?.removeController(this.consumer);
    }
    this.consumer = undefined;
    this.runtime = undefined;
  }

  override disconnected() {
    this.disconnect();
  }
  override reconnected() {
    this.connect();
    this.refresh();
  }

  override render(
    surface: ControlUiSurface,
    props: unknown,
    defaultView: unknown,
    presented: boolean,
  ) {
    // Built-in renderers remain synchronous and do not create a component for
    // every transcript row. Only a selected replacement owns a DOM mount.
    return this.runtime?.selectedReplacement(surface)
      ? html`<openclaw-plugin-view
          ?data-plugin-composer=${surface === "composer"}
          .surface=${surface}
          .props=${props}
          .defaultView=${defaultView}
          .defaultHost=${this.host}
          .presented=${presented}
        ></openclaw-plugin-view>`
      : defaultView;
  }
}

const pluginSurface = directive(PluginSurfaceDirective);

export function renderPluginSurface<S extends ControlUiSurface>(
  surface: S,
  props: ControlUiSurfaceProps[S],
  defaultView: unknown,
  presented = true,
) {
  return pluginSurface(surface, props, defaultView, presented);
}

export function renderPluginContribution(
  kind: Exclude<ViewKind, "replacements">,
  key: string,
  props: unknown,
  defaultView: unknown = nothing,
  presented = true,
) {
  return html`<openclaw-plugin-view
    .kind=${kind}
    .contributionKey=${key}
    .props=${props}
    .defaultView=${defaultView}
    .presented=${presented}
  ></openclaw-plugin-view>`;
}
