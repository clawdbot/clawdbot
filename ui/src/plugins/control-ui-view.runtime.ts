import { consume } from "@lit/context";
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing, render, type LitElement, type PropertyValues } from "lit";
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
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import type { ViewKind } from "./control-ui-view.ts";

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
  private ownerChanged = false;
  private handle?: ReturnType<ControlUiView<unknown>>;
  private viewContext?: ControlUiViewContext<unknown>;
  private readonly defaultContainers = new Set<HTMLElement>();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.plugins,
    (plugins, notify) => plugins.subscribe(notify),
    () => {
      const next = this.resolveRegistration();
      if (this.registration?.value !== next?.value || this.registration?.signal !== next?.signal) {
        // Selection can leave and return before Lit renders. Retirement cannot wait.
        this.ownerChanged = true;
        this.mountAbort?.abort();
      }
    },
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

  override requestUpdate(...args: Parameters<OpenClawLightDomContentsElement["requestUpdate"]>) {
    const [name, previous] = args;
    if (name === "props") {
      // SAFETY: host renderers supply props records; plugin page props may omit session identity.
      const before = previous as Partial<BoardGetParams> | undefined;
      // SAFETY: the next value follows the same host-owned props contract.
      const after = this.props as Partial<BoardGetParams> | undefined;
      if (before?.sessionKey !== after?.sessionKey || before?.agentId !== after?.agentId) {
        // Record every transition, including A→B→A before Lit renders; old handles stay retired.
        this.ownerChanged = true;
        this.mountAbort?.abort();
      }
    }
    super.requestUpdate(...args);
  }

  protected override shouldUpdate(): boolean {
    // Lit may finish a queued update after removal. Rendering the retired
    // default template would move retained host nodes out of the restored UI.
    return this.isConnected;
  }

  override willUpdate(): void {
    // Failure recovery renders the original template here. Its method handlers
    // must keep the same receiver as the built-in owner and mountDefault.
    this.renderOptions.host = this.defaultHost ?? this;
    const next = this.resolveRegistration();
    if (
      this.registration?.value !== next?.value ||
      this.registration?.signal !== next?.signal ||
      this.ownerChanged
    ) {
      this.ownerChanged = false;
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
