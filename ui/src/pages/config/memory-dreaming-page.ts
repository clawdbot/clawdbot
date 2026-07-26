// Controller for the Dreaming tab of the Memory settings page. The dreaming
// sweep is one managed cron job over every agent workspace, so its knobs are
// global and belong on a global page; only the diary/short-term reads below are
// agent-scoped, which is what the agent picker drives.
import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/agent-select-registration.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  resolveConfiguredDreaming,
  resolveDreamingConfigPathSupport,
  type DreamingConfigPathSupport,
} from "../agents/memory/dreaming.ts";
import "../agents/memory/memory-panel.ts";
import { renderDreamingSettings, renderDreamingUnsupported } from "./memory-dreaming.ts";
import { renderConfigApplyBanner, renderConfigAutoSaveStatus } from "./view.ts";

class MemoryDreamingSettings extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private selectedAgentId: string | null = null;
  // Starts optimistic: the knobs stay editable until a schema lookup proves the
  // slot owner cannot store them, so a slow or offline lookup never blanks the
  // tab for the plugin that ships dreaming.
  @state() private support: DreamingConfigPathSupport = "supported";
  private supportPluginId: string | null = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.syncSupport(runtimeConfig),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      (agents) => {
        if (!agents.state.agentsList && !agents.state.agentsLoading) {
          void agents.ensureList().catch(() => undefined);
        }
      },
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.supportPluginId = null;
    super.disconnectedCallback();
  }

  private configObject(): Record<string, unknown> | null {
    return currentConfigObject(this.context.runtimeConfig.state);
  }

  /** Slot-resolved owner of dreaming config; never a hardcoded plugin id here. */
  private dreamingPluginId(): string {
    return resolveConfiguredDreaming(this.configObject()).pluginId;
  }

  private dreamingConfig(): Record<string, unknown> | null {
    const plugins = asConfigRecord(this.configObject()?.plugins);
    const entry = asConfigRecord(asConfigRecord(plugins?.entries)?.[this.dreamingPluginId()]);
    return asConfigRecord(asConfigRecord(entry?.config)?.dreaming);
  }

  /**
   * Reuses the enablement flow's capability check so exactly one rule decides
   * whether an alternate memory engine can hold `config.dreaming`.
   */
  private syncSupport(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const pluginId = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state)).pluginId;
    if (pluginId === this.supportPluginId) {
      return;
    }
    this.supportPluginId = pluginId;
    this.support = "supported";
    void resolveDreamingConfigPathSupport(runtimeConfig, pluginId).then((support) => {
      if (this.isConnected && this.supportPluginId === pluginId) {
        this.support = support;
      }
    });
  }

  private patch(path: readonly string[], value: unknown) {
    const runtimeConfig = this.context.runtimeConfig;
    const writePath = [
      "plugins",
      "entries",
      this.dreamingPluginId(),
      "config",
      "dreaming",
      ...path,
    ];
    if (value === undefined) {
      runtimeConfig.removeFormValue(writePath);
      return;
    }
    runtimeConfig.patchForm(writePath, value);
  }

  private resolveAgentId(): string | null {
    const agentsList = this.context.agents.state.agentsList;
    const selectable = listSelectableAgents(agentsList?.agents ?? []);
    if (this.selectedAgentId && selectable.some((agent) => agent.id === this.selectedAgentId)) {
      return this.selectedAgentId;
    }
    return agentsList?.defaultId ?? selectable[0]?.id ?? null;
  }

  /**
   * These knobs autosave like the schema editor, so the tab owns the same
   * status line and restart banner the embedded editor renders on the other
   * tabs; without them a saved edit looks like nothing happened.
   */
  private renderWriteStatus() {
    const runtimeConfig = this.context.runtimeConfig;
    const configState = runtimeConfig.state;
    const status = renderConfigAutoSaveStatus({
      status: configState.configAutoSaveStatus,
      onRetry: () => void runtimeConfig.save(),
      onReload: () => void runtimeConfig.discardDraft(),
    });
    return html`
      ${status === nothing
        ? nothing
        : html`<div class="config-toolbar__status" role="status" aria-live="polite">
            ${status}
          </div>`}
      ${renderConfigApplyBanner({
        needsApply: configState.configNeedsApply,
        applying: configState.configApplying,
        busy:
          configState.configSaving ||
          configState.configLoading ||
          configState.configAutoSaveStatus === "saving",
        connected: configState.connected,
        onApply: () => void runtimeConfig.apply(),
      })}
    `;
  }

  private renderAgentPicker(agentId: string | null): TemplateResult {
    const agents = listSelectableAgents(this.context.agents.state.agentsList?.agents ?? []);
    const options: AgentSelectOption[] = agents.map((agent) => ({
      value: agent.id,
      label: normalizeAgentLabel(agent),
      agent,
    }));
    return renderSettingsSection(
      {
        title: t("memoryPage.dreaming.agentScope.title"),
        description: t("memoryPage.dreaming.agentScope.description"),
      },
      renderSettingsRow({
        title: t("memoryPage.dreaming.agentScope.rowTitle"),
        control: html`
          <openclaw-agent-select
            .options=${options}
            .value=${agentId ?? ""}
            .accessibleLabel=${t("memoryPage.dreaming.agentScope.rowTitle")}
            .onSelect=${(value: string) => {
              this.selectedAgentId = value || null;
            }}
          ></openclaw-agent-select>
        `,
      }),
    );
  }

  override render() {
    const agentId = this.resolveAgentId();
    const pluginId = this.dreamingPluginId();
    return html`
      <div class="settings-page">
        ${this.renderWriteStatus()}
        <p class="settings-page__intro">${t("memoryPage.dreaming.intro", { plugin: pluginId })}</p>
        ${this.support === "unsupported"
          ? renderDreamingUnsupported(pluginId)
          : renderDreamingSettings({
              dreaming: this.dreamingConfig(),
              onPatch: (path, value) => this.patch(path, value),
            })}
        ${this.renderAgentPicker(agentId)}
      </div>
      ${agentId
        ? html`<openclaw-agent-memory-panel .agentId=${agentId}></openclaw-agent-memory-panel>`
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-memory-dreaming")) {
  customElements.define("openclaw-memory-dreaming", MemoryDreamingSettings);
}
