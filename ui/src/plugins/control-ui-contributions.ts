import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  isOptionalElementDefined,
  LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "../app/lazy-custom-element.ts";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";

const PLUGIN_MANAGER_DIALOG = {
  tagName: "openclaw-plugin-manager-dialog",
  get label() {
    return t("pluginUi.customize");
  },
  loadModule: () => import("./control-ui-manager-dialog.ts"),
} satisfies OptionalCustomElement;

export function renderControlUiPluginRecovery(plugins: ControlUiPluginCapability, routeId: string) {
  // A workspace replacement can remove the Plugins page, so its escape stays host-owned.
  return routeId !== "plugins" || plugins.selectedReplacement("workspace")
    ? html`<openclaw-plugin-manager floating></openclaw-plugin-manager>`
    : nothing;
}

class ControlUiPluginManager extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  @property({ type: Boolean }) floating = false;
  @state() private open = false;
  private readonly dialogLoader = new LazyCustomElementRequestController(this, () => {
    this.open = false;
  });

  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.context?.plugins,
      (plugins, notify) => plugins.subscribe(notify),
    );
  }

  private get available(): boolean {
    const runtime = this.context?.plugins;
    // Page-only plugins still need administrative reload, but not a floating control.
    return Boolean(
      runtime &&
      (this.floating || !runtime.selectedReplacement("workspace")) &&
      (runtime.registrations("replacements").length ||
        runtime.errors.length ||
        (!this.floating && runtime.hasPlugins && runtime.canReload)),
    );
  }

  override willUpdate() {
    this.dialogLoader.requestWhileActive(
      PLUGIN_MANAGER_DIALOG,
      this.isConnected && this.available && this.open,
    );
  }

  override disconnectedCallback() {
    this.dialogLoader.requestWhileActive(PLUGIN_MANAGER_DIALOG, false);
    super.disconnectedCallback();
  }

  override render() {
    // The loader closes its modal after the registered element has rendered.
    const showDialog = this.available && this.open && !this.dialogLoader.visibleState;
    return html`${
      this.available
        ? html`<button
              class=${`btn btn--sm${this.floating ? " plugin-ui-recovery" : ""}`}
              type="button"
              @click=${() => {
                this.open = true;
              }}
            >
              ${t("pluginUi.customize")}
            </button>
            ${renderLazyElementModal(this.dialogLoader)}`
        : nothing
    }
    ${
      isOptionalElementDefined(PLUGIN_MANAGER_DIALOG)
        ? html`<openclaw-plugin-manager-dialog
            .runtime=${this.context?.plugins}
            .open=${showDialog}
            @modal-cancel=${() => {
              this.open = false;
            }}
          ></openclaw-plugin-manager-dialog>`
        : nothing
    }`;
  }
}

if (!customElements.get("openclaw-plugin-manager")) {
  customElements.define("openclaw-plugin-manager", ControlUiPluginManager);
}
