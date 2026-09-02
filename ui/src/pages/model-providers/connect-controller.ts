import type { ReactiveController, ReactiveControllerHost } from "lit";
import { html } from "lit";
import { titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import {
  renderLearnMoreLink,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { MODELS_CONNECT_NAVIGATION, modelsNavigationOptions } from "./location.ts";
import type { ModelProvidersRouteData } from "./route.ts";

const MODEL_PROVIDERS_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type ModelConnectHost = ReactiveControllerHost & HTMLElement;

type ModelConnectControllerOptions = {
  getContext: () => ApplicationContext;
  getRouteData: () => ModelProvidersRouteData | undefined;
  getSelectedAgentId: () => string;
};

export class ModelConnectController implements ReactiveController {
  private loaded = false;
  private loadError: string | null = null;
  private load: Promise<void> | null = null;
  private restoreFocus = false;

  constructor(
    private readonly host: ModelConnectHost,
    private readonly options: ModelConnectControllerOptions,
  ) {
    host.addController(this);
  }

  hostUpdate() {
    if (this.options.getRouteData()?.view === "connect") {
      void this.ensureLoaded();
    }
  }

  hostUpdated() {
    if (this.restoreFocus && this.options.getRouteData()?.view !== "connect") {
      this.restoreFocus = false;
      this.host.querySelector<HTMLButtonElement>("[data-models-connect]")?.focus();
    }
  }

  open() {
    this.options.getContext().navigate("model-providers", MODELS_CONNECT_NAVIGATION);
  }

  close() {
    this.restoreFocus = true;
    this.options
      .getContext()
      .navigate("model-providers", modelsNavigationOptions({ view: "manage" }));
  }

  render() {
    const routeData = this.options.getRouteData();
    const firstRun = routeData?.firstRun === true;
    const content = this.loaded
      ? html`<openclaw-model-setup-page
          ?embedded=${!firstRun}
          .routeData=${{ firstRun }}
        ></openclaw-model-setup-page>`
      : this.loadError
        ? renderSettingsPage(html`
            <div class="callout danger" role="alert">${this.loadError}</div>
            <button type="button" class="btn" @click=${() => void this.ensureLoaded()}>
              ${t("common.retry")}
            </button>
          `)
        : renderSettingsPage(renderSettingsLoadingSkeleton());
    if (firstRun) {
      return content;
    }
    const context = this.options.getContext();
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("model-providers"),
        subtitle: html`${t("modelProviders.subtitle")}
        ${renderLearnMoreLink(MODEL_PROVIDERS_DOCS_URL)}`,
        actions: html`
          ${renderAgentScopeControl({
            agents: context.agents.state.agentsList?.agents ?? [],
            selection: context.agentSelection,
            allowAll: false,
            selectedId: this.options.getSelectedAgentId(),
          })}
          <button class="btn" data-models-manage @click=${() => this.close()}>
            ${icons.arrowLeft}<span>${t("common.back")}</span>
          </button>
        `,
      })}
      ${renderSettingsWorkspace(content)}
    `;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (this.load) {
      return this.load;
    }
    this.loadError = null;
    const load = import("../model-setup/model-setup-page.ts")
      .then(() => {
        if (this.load === load) {
          this.loaded = true;
          this.load = null;
          this.host.requestUpdate();
        }
      })
      .catch((error: unknown) => {
        if (this.load === load) {
          this.load = null;
          this.loadError = formatUiError(error, t("modelSetup.errors.requestFailed"));
          this.host.requestUpdate();
        }
      });
    this.load = load;
    return load;
  }
}
