import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { icons, type IconName } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";
import { renderPluginContribution } from "./control-ui-view.ts";

class ControlUiPluginContributions extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) kind: "navigation" | "session-header" | "composer" | "header" =
    "navigation";
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) navigationKey = "";
  @property({ attribute: false }) excludedNavigationKeys: readonly string[] = [];
  @property({ type: Boolean }) presented = true;
  @state() private actionError = "";
  private lifetime = new AbortController();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.plugins,
    (plugins, notify) => plugins.subscribe(notify),
  );

  override connectedCallback() {
    if (this.lifetime.signal.aborted) {
      this.lifetime = new AbortController();
    }
    super.connectedCallback();
  }

  override disconnectedCallback() {
    this.lifetime.abort();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changes: Map<PropertyKey, unknown>) {
    if (changes.has("sessionKey")) {
      this.lifetime.abort();
      this.lifetime = new AbortController();
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
            { sessionKey: this.sessionKey },
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
        const session = this.context?.sessions.state.result?.sessions.find(
          (row) => row.key === this.sessionKey,
        );
        const params = {
          sessionKey: this.sessionKey,
          session: session ? structuredClone(session) : undefined,
        };
        let actionState: ReturnType<NonNullable<typeof entry.value.resolve>> | undefined;
        try {
          actionState = entry.value.resolve?.(params);
        } catch (error) {
          runtime.reportError(entry.pluginId, error);
          return nothing;
        }
        if (actionState?.hidden) {
          return nothing;
        }
        return html`<button
          class="btn btn--sm"
          type="button"
          ?disabled=${actionState?.disabled ?? false}
          @click=${async () => {
            const signal = AbortSignal.any([this.lifetime.signal, entry.signal]);
            if (signal.aborted || entry.signal.aborted) {
              return;
            }
            this.actionError = "";
            try {
              const next = entry.value.resolve?.(params);
              if (next?.hidden || next?.disabled) {
                return;
              }
              await entry.value.run({
                ...params,
                host: scopeControlUiHost(entry.host, signal),
                signal,
              });
            } catch (error) {
              if (!signal.aborted && !entry.signal.aborted) {
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
