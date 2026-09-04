import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";
import { renderCustomPluginUiDisabled } from "./control-ui-disabled.ts";
import "../components/modal-dialog.ts";

class ControlUiPluginManagerDialog extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ attribute: false }) runtime?: ControlUiPluginCapability;
  @property({ type: Boolean }) open = false;
  @state() private reloading = false;
  @state() private reloadError = "";
  private readonly close = () =>
    this.dispatchEvent(new Event("modal-cancel", { bubbles: true, composed: true }));

  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.runtime,
      (runtime, notify) => runtime.subscribe(notify),
    );
  }

  override render() {
    const runtime = this.runtime;
    if (!this.open || !runtime) {
      return nothing;
    }
    const replacements = runtime.registrations("replacements");
    const surfaces = [...new Set(replacements.map((entry) => entry.value.surface))];
    return html`<openclaw-modal-dialog .label=${t("pluginUi.customize")}>
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
        ${runtime.errors.map((entry) => {
          const disabled = renderCustomPluginUiDisabled(this.context, entry.pluginId, this.close);
          return disabled
            ? html`<section role="status"><strong>${entry.pluginId}</strong>${disabled}</section>`
            : html`<p role="alert"><strong>${entry.pluginId}</strong>: ${entry.message}</p>`;
        })}
        ${this.reloadError ? html`<p role="alert">${this.reloadError}</p>` : nothing}
        ${
          runtime.canReload
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
            : nothing
        }
        <button class="btn" @click=${() => void runtime.refresh()}>${t("common.retry")}</button>
        <button class="btn" @click=${this.close}>${t("common.close")}</button>
      </section>
    </openclaw-modal-dialog>`;
  }
}

if (!customElements.get("openclaw-plugin-manager-dialog")) {
  customElements.define("openclaw-plugin-manager-dialog", ControlUiPluginManagerDialog);
}
