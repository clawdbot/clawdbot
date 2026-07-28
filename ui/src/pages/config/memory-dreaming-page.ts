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
  // "unknown" renders optimistically: the knobs stay editable until a schema
  // lookup proves the slot owner cannot store them, so a slow or offline lookup
  // never blanks the tab for the plugin that ships dreaming.
  @state() private support: DreamingConfigPathSupport = "unknown";
  private supportPluginId: string | null = null;
  /**
   * The in-flight capability probe, if any. Object identity is the generation:
   * a plugin id alone cannot tell a current answer from a stale one, because
   * both the slot owner and the connection can change while a lookup is
   * outstanding (A -> B -> A, or a disconnect and reconnect on the same owner).
   */
  private supportProbe: { pluginId: string } | null = null;

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
    this.supportProbe = null;
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
   * whether an alternate memory engine can hold `config.dreaming`. Only a
   * definitive answer is kept: a lookup made while the gateway was unreachable
   * answers "unknown" and must be retried on reconnect, or the page would stay
   * optimistically editable for an engine that cannot store these knobs.
   */
  private syncSupport(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const pluginId = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state)).pluginId;
    if (pluginId !== this.supportPluginId) {
      this.supportPluginId = pluginId;
      this.support = "unknown";
    }
    const connected = runtimeConfig.state.connected;
    // Abandoning the probe here is what makes the reconnect re-probe: leaving it
    // armed would make this call look like "already in flight" and swallow the
    // retry that an `unknown` answer requires.
    if (this.supportProbe && (this.supportProbe.pluginId !== pluginId || !connected)) {
      this.supportProbe = null;
    }
    if (this.support !== "unknown" || this.supportProbe || !connected) {
      return;
    }
    const probe = { pluginId };
    this.supportProbe = probe;
    void resolveDreamingConfigPathSupport(runtimeConfig, pluginId).then((support) => {
      if (this.supportProbe !== probe) {
        return;
      }
      this.supportProbe = null;
      if (this.isConnected) {
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
   * active-write/failure status and restart banner as the other tabs.
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
