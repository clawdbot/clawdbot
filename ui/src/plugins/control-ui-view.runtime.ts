import { consume } from "@lit/context";
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing, render, type LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  ControlUiAction,
  ControlUiSurface,
  ControlUiSurfaceProps,
  ControlUiView,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { icons, type IconName } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { findUiSessionRow } from "../lib/sessions/route-navigation.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import { renderPluginContribution, type ViewKind } from "./control-ui-view.ts";

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

  override updated(): void {
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
            this.toggleAttribute("data-plugin-default-mounted", true);
            render(this.defaultView, target, { host: this.defaultHost ?? this });
            return () => {
              this.defaultContainers.delete(target);
              this.toggleAttribute("data-plugin-default-mounted", this.defaultContainers.size > 0);
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
    this.removeAttribute("data-plugin-default-mounted");
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
      return html`${
        this.error
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
          : nothing
      }${this.defaultView}`;
    }
    // The host owns the mount root. A new lifetime gets new DOM even when the
    // plugin has no disposer or its framework caches render state on the root.
    return keyed(
      this.mountGeneration,
      html`<div data-plugin-view-root style="display: contents"></div>`,
    );
  }
}

class ControlUiPluginContributions extends OpenClawLightDomContentsElement {
  private lifetime = new AbortController();
  private readonly actionLifetimes = new Map<
    AbortSignal,
    { entry: ControlUiRegistration<ControlUiAction>; abort: AbortController }
  >();
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) kind: "navigation" | "session-header" | "composer" | "header" =
    "navigation";
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId?: string;
  @property({ attribute: false }) navigationKey = "";
  @property({ attribute: false }) excludedNavigationKeys: readonly string[] = [];
  @property({ type: Boolean }) presented = true;
  @state() private actionError = "";
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.plugins,
      (plugins, notify) => plugins.subscribe(notify),
      () => this.retireHiddenActions(),
    )
    .watch(
      () =>
        this.kind === "header" || this.kind === "composer" ? this.context?.sessions : undefined,
      (sessions, notify) => sessions.subscribe(notify),
      () => this.retireHiddenActions(),
    );

  override connectedCallback() {
    if (this.lifetime.signal.aborted) {
      this.lifetime = new AbortController();
    }
    super.connectedCallback();
  }

  override disconnectedCallback() {
    this.lifetime.abort();
    this.actionLifetimes.clear();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override requestUpdate(...args: Parameters<OpenClawLightDomContentsElement["requestUpdate"]>) {
    const [name, previous] = args;
    // Lit calls this synchronously; a hide/show before rendering still retires old actions.
    if (
      (name === "sessionKey" || name === "agentId" || name === "presented") &&
      this[name] !== previous
    ) {
      this.lifetime.abort();
      this.actionLifetimes.clear();
      this.lifetime = new AbortController();
    }
    super.requestUpdate(...args);
  }

  private currentSession() {
    return this.context ? findUiSessionRow(this.context, this.sessionKey, this.agentId) : undefined;
  }

  private resolveAction(
    entry: ControlUiRegistration<ControlUiAction>,
  ): ReturnType<NonNullable<ControlUiAction["resolve"]>> | undefined {
    const session = this.currentSession();
    try {
      return entry.value.resolve?.({
        sessionKey: this.sessionKey,
        agentId: this.agentId ?? session?.agentId,
        session: session ? structuredClone(session) : undefined,
      });
    } catch (error) {
      this.retireAction(entry.signal);
      this.context?.plugins.reportError(entry.pluginId, error);
      return { hidden: true };
    }
  }

  private retireAction(signal: AbortSignal) {
    const action = this.actionLifetimes.get(signal);
    this.actionLifetimes.delete(signal);
    action?.abort.abort();
  }

  private retireHiddenActions() {
    for (const [signal, { entry }] of this.actionLifetimes) {
      // An action may disable itself while running. Hiding instead retires
      // its retained invocations before awaited work can resume.
      if (signal.aborted || this.resolveAction(entry)?.hidden) {
        this.retireAction(signal);
      }
    }
  }

  override render() {
    const runtime = this.context?.plugins;
    if (!runtime) {
      return nothing;
    }
    if (this.kind === "navigation") {
      return runtime
        .registrations("navigation")
        .filter((entry) =>
          this.navigationKey
            ? entry.key === this.navigationKey
            : entry.value.defaultVisible !== false &&
              !this.excludedNavigationKeys.includes(entry.key),
        )
        .toSorted(
          (a, b) => (a.value.order ?? 0) - (b.value.order ?? 0) || a.key.localeCompare(b.key),
        )
        .map((entry) => {
          const href = entry.host.navigation.pageHref(entry.value.page);
          const active = href === `${window.location.pathname}${window.location.search}`;
          let icon: IconName = "puzzle";
          if (entry.value.icon && Object.hasOwn(icons, entry.value.icon)) {
            // SAFETY: the own-key check narrows this plugin-provided name to the icon registry.
            icon = entry.value.icon as IconName;
          }
          return html`<a
            class="nav-item ${active ? "nav-item--active" : ""}"
            href=${href}
            aria-current=${active ? "page" : nothing}
            @click=${(event: MouseEvent) => {
              if (!shouldHandleNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              entry.host.navigation.openPage(entry.value.page);
            }}
            ><span class="nav-item__icon" aria-hidden="true">${icons[icon]}</span
            ><span class="nav-item__text">${entry.value.label}</span></a
          >`;
        });
    }
    if (this.kind === "session-header") {
      return runtime
        .registrations("accessories")
        .filter((entry) => entry.value.placement === "session-header")
        .map((entry) =>
          renderPluginContribution(
            "accessories",
            entry.key,
            { sessionKey: this.sessionKey, agentId: this.agentId },
            nothing,
            this.presented,
          ),
        );
    }
    return html`${
      this.actionError ? html`<span role="alert">${this.actionError}</span>` : nothing
    }${runtime
      .registrations("actions")
      .filter((entry) => entry.value.placement === this.kind)
      .map((entry) => {
        const actionState = this.resolveAction(entry);
        if (actionState?.hidden) {
          this.retireAction(entry.signal);
          return nothing;
        }
        let actionLifetime = this.actionLifetimes.get(entry.signal);
        if (!actionLifetime) {
          actionLifetime = { entry, abort: new AbortController() };
          this.actionLifetimes.set(entry.signal, actionLifetime);
        }
        const signal = AbortSignal.any([
          this.lifetime.signal,
          entry.signal,
          actionLifetime.abort.signal,
        ]);
        return html`<button
          class="btn btn--sm"
          type="button"
          ?disabled=${actionState?.disabled ?? false}
          @click=${async () => {
            if (signal.aborted || !this.presented || !this.isConnected) {
              return;
            }
            this.actionError = "";
            try {
              await runControlUiPluginAction({
                runtime,
                id: entry.key,
                placement: entry.value.placement,
                sessionKey: this.sessionKey,
                agentId: this.agentId,
                session: this.currentSession(),
                signal,
              });
            } catch (error) {
              if (!signal.aborted) {
                this.actionError = error instanceof Error ? error.message : String(error);
              }
            }
          }}
        >
          ${actionState?.label ?? entry.value.label}
        </button>`;
      })}`;
  }
}

if (!customElements.get("openclaw-plugin-contributions")) {
  customElements.define("openclaw-plugin-contributions", ControlUiPluginContributions);
}
if (!customElements.get("openclaw-plugin-view")) {
  customElements.define("openclaw-plugin-view", ControlUiPluginView);
}
