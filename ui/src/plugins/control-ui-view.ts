import { consume, ContextConsumer } from "@lit/context";
import { html, LitElement, nothing, render, type ChildPart, type PropertyValues } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  ControlUiSurface,
  ControlUiSurfaceProps,
  ControlUiView,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ControlUiPluginRuntime, ControlUiRegistration } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

type ViewKind = "pages" | "panels" | "accessories" | "widgets" | "replacements";
type ViewRegistration = ControlUiRegistration<{ mount: ControlUiView<unknown> }>;

class ControlUiPluginView extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @property({ attribute: false }) kind: ViewKind = "replacements";
  @property({ attribute: false }) contributionKey = "";
  @property({ attribute: false }) surface: ControlUiSurface = "workspace";
  @property({ attribute: false }) props: unknown = {};
  @property({ attribute: false }) defaultView: unknown = nothing;
  @property({ attribute: false }) defaultHost?: LitElement;
  @property({ type: Boolean }) presented = true;
  @state() private error = "";
  private registration?: ViewRegistration;
  private mountAbort?: AbortController;
  private mountGeneration = 0;
  private handle?: ReturnType<ControlUiView<unknown>>;
  private viewContext?: ControlUiViewContext<unknown>;
  private readonly defaultContainers = new Set<HTMLElement>();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.plugins,
    (plugins, notify) => plugins.subscribe(notify),
  );

  private resolveRegistration(): ViewRegistration | undefined {
    const runtime = this.context?.plugins;
    const entry =
      this.kind === "replacements"
        ? runtime?.selectedReplacement(this.surface)
        : runtime
            ?.registrations(this.kind)
            .find((candidate) => candidate.key === this.contributionKey);
    // SAFETY: the host renderer pairs each registry kind/surface with its SDK props; only this private mount erases them.
    return entry as ViewRegistration | undefined;
  }

  protected override shouldUpdate(): boolean {
    // Lit may finish a queued update after removal. Rendering the retired
    // default template would move retained host nodes out of the restored UI.
    return this.isConnected;
  }

  override willUpdate(changes: PropertyValues<this>): void {
    // Failure recovery renders the original template here. Its method handlers
    // must keep the same receiver as the built-in owner and mountDefault.
    this.renderOptions.host = this.defaultHost ?? this;
    const next = this.resolveRegistration();
    // SAFETY: every SDK view receives a host-owned props record; pages may omit the session key.
    const previousProps = changes.get("props") as { sessionKey?: string } | undefined;
    // SAFETY: the same host-owned record contract applies to the next props value.
    const nextProps = this.props as { sessionKey?: string } | undefined;
    if (
      this.registration?.value !== next?.value ||
      this.registration?.signal !== next?.signal ||
      (changes.has("props") && previousProps?.sessionKey !== nextProps?.sessionKey)
    ) {
      this.unmount();
      this.registration = next;
      this.error = "";
    }
  }

  override updated(_changes: PropertyValues<this>): void {
    const registration = this.registration;
    if (!registration || this.error || registration.signal.aborted) {
      return;
    }
    try {
      if (!this.mountAbort) {
        const container = this.querySelector<HTMLElement>("[data-plugin-view-root]");
        if (!container) {
          return;
        }
        const abort = new AbortController();
        this.mountAbort = abort;
        registration.signal.addEventListener(
          "abort",
          () => {
            this.unmount();
            this.requestUpdate();
          },
          { once: true, signal: abort.signal },
        );
        this.viewContext = {
          host: scopeControlUiHost(registration.host, abort.signal),
          signal: abort.signal,
          props: this.scopedProps(abort.signal),
          presented: this.presented,
          mountDefault: (target) => {
            if (abort.signal.aborted) {
              throw new Error("This plugin UI view has ended.");
            }
            this.defaultContainers.add(target);
            render(this.defaultView, target, { host: this.defaultHost ?? this });
            return () => {
              this.defaultContainers.delete(target);
              render(nothing, target);
            };
          },
        };
        this.handle = registration.value.mount(container, this.viewContext);
      } else if (this.viewContext) {
        this.viewContext = {
          ...this.viewContext,
          props: this.scopedProps(this.mountAbort.signal),
          presented: this.presented,
        };
        this.handle?.update?.(this.viewContext);
      }
      for (const container of this.defaultContainers) {
        render(this.defaultView, container, { host: this.defaultHost ?? this });
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private scopedProps(signal: AbortSignal): unknown {
    if (this.kind !== "replacements" || this.surface !== "composer") {
      return structuredClone(this.props);
    }
    // SAFETY: renderPluginSurface supplies composer props only for the discriminants checked above.
    const props = this.props as ControlUiSurfaceProps["composer"];
    const check = () => {
      if (signal.aborted || this.registration?.signal.aborted) {
        throw new Error("This plugin UI view has ended.");
      }
    };
    return {
      ...props,
      setDraft: (text: string) => {
        check();
        props.setDraft(text);
      },
      send: async () => {
        check();
        const result = await props.send();
        check();
        return result;
      },
      abort: props.abort
        ? () => {
            check();
            props.abort!();
          }
        : undefined,
    };
  }

  override focus(options?: FocusOptions): void {
    if (this.handle?.focus) {
      this.handle.focus();
      return;
    }
    const input = this.querySelector<HTMLElement>("textarea, input, [contenteditable=true]");
    if (input) {
      input.focus(options);
    } else {
      super.focus(options);
    }
  }

  private fail(error: unknown): void {
    const pluginId = this.registration?.pluginId ?? "host";
    this.unmount();
    this.error = error instanceof Error ? error.message : String(error);
    this.context?.plugins.reportError(pluginId, error);
  }

  private unmount(): void {
    this.mountGeneration += 1;
    this.mountAbort?.abort();
    this.mountAbort = undefined;
    const handle = this.handle;
    this.handle = undefined;
    try {
      handle?.dispose?.();
    } catch (error) {
      this.context?.plugins.reportError(this.registration?.pluginId ?? "host", error);
    }
    for (const container of this.defaultContainers) {
      render(nothing, container);
    }
    this.defaultContainers.clear();
    this.viewContext = undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.unmount();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    if (!this.registration || this.error) {
      return html`${this.error
        ? html`<div class="card" role="alert">
            ${this.error}<button
              class="btn btn--sm"
              @click=${() => {
                this.error = "";
              }}
            >
              ${t("pluginUi.retryView")}
            </button>
          </div>`
        : nothing}${this.defaultView}`;
    }
    // The host owns the mount root. A new lifetime gets new DOM even when the
    // plugin has no disposer or its framework caches render state on the root.
    return keyed(
      this.mountGeneration,
      html`<div data-plugin-view-root style="display: contents"></div>`,
    );
  }
}

if (!customElements.get("openclaw-plugin-view")) {
  customElements.define("openclaw-plugin-view", ControlUiPluginView);
}

class PluginSurfaceDirective extends AsyncDirective {
  private host?: LitElement;
  private consumer?: ContextConsumer<typeof applicationContext, LitElement>;
  private runtime?: ControlUiPluginRuntime;
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
