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
  private setup:
    | { phase: "idle" }
    | { phase: "loading"; load: Promise<void> }
    | { phase: "ready" }
    | { phase: "failed"; message: string } = { phase: "idle" };
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
    const setup = this.setup;
    const content =
      setup.phase === "ready"
        ? html`<openclaw-model-setup-page
            ?embedded=${!firstRun}
            .routeData=${{ firstRun }}
          ></openclaw-model-setup-page>`
        : setup.phase === "failed"
          ? renderSettingsPage(html`
              <div class="callout danger" role="alert">${setup.message}</div>
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
    if (this.setup.phase === "ready") {
      return Promise.resolve();
    }
    if (this.setup.phase === "loading") {
      return this.setup.load;
    }
    // Only the load that still owns this slot may publish its outcome; a retry
    // replaces the slot and the superseded import resolves into nothing.
    const owns = () => this.setup.phase === "loading" && this.setup.load === load;
    const load = import("../model-setup/model-setup-page.ts")
      .then(() => {
        if (owns()) {
          this.setup = { phase: "ready" };
          this.host.requestUpdate();
        }
      })
      .catch((error: unknown) => {
        if (owns()) {
          this.setup = {
            phase: "failed",
            message: formatUiError(error, t("modelSetup.errors.requestFailed")),
          };
          this.host.requestUpdate();
        }
      });
    this.setup = { phase: "loading", load };
    return load;
  }
}
