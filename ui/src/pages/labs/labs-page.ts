import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  isLabFeatureEnabled,
  labFeatureMergePatch,
  LAB_FEATURES,
  type LabFeature,
} from "./labs-registry.ts";

class LabsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private busyFeatureId: string | null = null;
  @state() private pendingValues: Readonly<Record<string, boolean>> = {};
  @state() private saveError: string | null = null;

  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      void runtimeConfig.ensureLoaded();
      return runtimeConfig.subscribe(() => this.requestUpdate());
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private featureEnabled(feature: LabFeature): boolean {
    const pending = this.pendingValues[feature.id];
    if (pending !== undefined) {
      return pending;
    }
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    return isLabFeatureEnabled(resolveEditableSnapshotConfig(snapshot), feature);
  }

  private canToggle(): boolean {
    const configState = this.context?.runtimeConfig.state;
    return Boolean(
      configState?.connected &&
      configState.configSnapshot?.hash &&
      !configState.configLoading &&
      this.busyFeatureId === null,
    );
  }

  private clearPendingValue(featureId: string) {
    const next = { ...this.pendingValues };
    delete next[featureId];
    this.pendingValues = next;
  }

  private async setFeatureEnabled(feature: LabFeature, enabled: boolean) {
    if (!this.canToggle()) {
      return;
    }
    const runtimeConfig = this.context.runtimeConfig;
    this.busyFeatureId = feature.id;
    this.pendingValues = { ...this.pendingValues, [feature.id]: enabled };
    this.saveError = null;
    try {
      const patched = await runtimeConfig.patch({
        raw: labFeatureMergePatch(feature, enabled),
        note: `labs: update ${feature.id}`,
      });
      if (!patched) {
        this.saveError = runtimeConfig.state.lastError ?? t("labsPage.saveFailed");
        return;
      }
      if (this.context.runtimeConfig === runtimeConfig) {
        await runtimeConfig.refresh();
      }
    } catch (error) {
      this.saveError = String(error);
    } finally {
      this.clearPendingValue(feature.id);
      if (this.busyFeatureId === feature.id) {
        this.busyFeatureId = null;
      }
    }
  }

  private renderFeature(feature: LabFeature) {
    const title = feature.title();
    const description = html`
      ${feature.description()}
      <a href=${feature.docsUrl} target=${EXTERNAL_LINK_TARGET} rel=${buildExternalLinkRel()}
        >${t("labsPage.documentation")}</a
      >${feature.restartHint ? html` <span>${feature.restartHint()}</span>` : nothing}
    `;
    return renderSettingsRow({
      title,
      description,
      control: renderSettingsToggle({
        checked: this.featureEnabled(feature),
        disabled: !this.canToggle(),
        ariaLabel: title,
        onChange: (enabled) => void this.setFeatureEnabled(feature, enabled),
      }),
    });
  }

  override render() {
    const rows = [
      ...LAB_FEATURES.map((feature) => this.renderFeature(feature)),
      this.saveError
        ? renderSettingsRow({
            title: t("labsPage.saveErrorTitle"),
            description: html`<span role="alert">${this.saveError}</span>`,
          })
        : nothing,
    ];
    const body = renderSettingsPage(
      renderSettingsSection(
        {
          title: t("labsPage.sectionTitle"),
          description: t("labsPage.sectionDescription"),
        },
        rows,
      ),
      { intro: t("labsPage.intro") },
    );
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("labs")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-labs-page")) {
  customElements.define("openclaw-labs-page", LabsPage);
}
