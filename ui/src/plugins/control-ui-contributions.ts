import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { icons, type IconName } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { findUiSessionRow } from "../lib/sessions/route-navigation.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-runtime.ts";
import { renderPluginContribution } from "./control-ui-view.ts";

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
    return html`${this.actionError
      ? html`<span role="alert">${this.actionError}</span>`
      : nothing}${runtime
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

class ControlUiPluginManager extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @state() private open = false;
  @state() private reloading = false;
  @state() private reloadError = "";
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.plugins,
    (plugins, notify) => plugins.subscribe(notify),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override render() {
    const runtime = this.context?.plugins;
    const replacements = runtime?.registrations("replacements") ?? [];
    if (!runtime || (!runtime.hasPlugins && !runtime.errors.length)) {
      return nothing;
    }
    const surfaces = [...new Set(replacements.map((entry) => entry.value.surface))];
    return html`<button
        class="btn btn--sm plugin-ui-recovery"
        type="button"
        @click=${() => {
          this.open = true;
        }}
      >
        ${t("pluginUi.customize")}
      </button>
      ${this.open
        ? html`<openclaw-modal-dialog
            .label=${t("pluginUi.customize")}
            @modal-cancel=${() => {
              this.open = false;
            }}
          >
            <section class="card">
              <h2>${t("pluginUi.customize")}</h2>
              <p>${t("pluginUi.selectionScope")}</p>
              ${surfaces.map(
                (surface) => html`<label class="field"
                  ><span>${t(`pluginUi.surface.${surface}`)}</span>
                  <select
                    @change=${(event: Event) =>
                      runtime.selectReplacement(
                        surface,
                        // SAFETY: this handler is bound directly to the select element.
                        (event.target as HTMLSelectElement).value || null,
                      )}
                  >
                    <option value="" .selected=${!runtime.selectedReplacement(surface)}>
                      ${t("pluginUi.builtin")}
                    </option>
                    ${replacements
                      .filter((entry) => entry.value.surface === surface)
                      .map(
                        (entry) =>
                          html`<option
                            value=${entry.key}
                            .selected=${runtime.selectedReplacement(surface)?.key === entry.key}
                          >
                            ${entry.value.label} (${entry.pluginId})
                          </option>`,
                      )}
                  </select></label
                >`,
              )}
              ${runtime.errors.map(
                (entry) =>
                  html`<p role="alert"><strong>${entry.pluginId}</strong>: ${entry.message}</p>`,
              )}
              ${this.reloadError ? html`<p role="alert">${this.reloadError}</p>` : nothing}
              ${runtime.canReload
                ? html`<button
                    class="btn"
                    ?disabled=${this.reloading}
                    @click=${async () => {
                      this.reloading = true;
                      this.reloadError = "";
                      try {
                        await runtime.reload();
                      } catch (error) {
                        this.reloadError = error instanceof Error ? error.message : String(error);
                      } finally {
                        this.reloading = false;
                      }
                    }}
                  >
                    ${t("pluginUi.reload")}
                  </button>`
                : nothing}
              <button
                class="btn"
                @click=${() => {
                  void runtime.refresh();
                }}
              >
                ${t("common.retry")}
              </button>
              <button
                class="btn"
                @click=${() => {
                  this.open = false;
                }}
              >
                ${t("common.close")}
              </button>
            </section>
          </openclaw-modal-dialog>`
        : nothing}`;
  }
}

if (!customElements.get("openclaw-plugin-contributions")) {
  customElements.define("openclaw-plugin-contributions", ControlUiPluginContributions);
}
if (!customElements.get("openclaw-plugin-manager")) {
  customElements.define("openclaw-plugin-manager", ControlUiPluginManager);
}
