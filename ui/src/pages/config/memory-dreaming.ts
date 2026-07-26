// Dreaming tab of the Memory settings page. The dreaming sweep is one managed
// cron job over every agent workspace, so its knobs are global and belong on a
// global page; only the diary/short-term reads below are agent-scoped, which is
// what the agent picker drives.
import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../components/agent-select-registration.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { resolveConfiguredDreaming } from "../agents/memory/dreaming.ts";
import "../agents/memory/memory-panel.ts";

type DreamingFieldSpec =
  | {
      kind: "text";
      path: readonly string[];
      labelKey: string;
      helpKey: string;
      placeholderKey?: string;
    }
  | { kind: "number"; path: readonly string[]; labelKey: string; helpKey: string; step?: number }
  | { kind: "toggle"; path: readonly string[]; labelKey: string; helpKey: string };

type DreamingFieldGroup = {
  titleKey: string;
  descriptionKey: string;
  fields: readonly DreamingFieldSpec[];
};

// Mirrors the memory-core manifest configSchema/uiHints
// (extensions/memory-core/openclaw.plugin.json). Everything here previously
// required hand-editing openclaw.json.
const DREAMING_SCHEDULE_FIELDS: readonly DreamingFieldSpec[] = [
  {
    kind: "text",
    path: ["frequency"],
    labelKey: "memoryPage.dreaming.frequency.label",
    helpKey: "memoryPage.dreaming.frequency.help",
    placeholderKey: "memoryPage.dreaming.frequency.placeholder",
  },
  {
    kind: "text",
    path: ["timezone"],
    labelKey: "memoryPage.dreaming.timezone.label",
    helpKey: "memoryPage.dreaming.timezone.help",
    placeholderKey: "memoryPage.dreaming.timezone.placeholder",
  },
  {
    kind: "text",
    path: ["model"],
    labelKey: "memoryPage.dreaming.model.label",
    helpKey: "memoryPage.dreaming.model.help",
    placeholderKey: "memoryPage.dreaming.model.placeholder",
  },
  {
    kind: "toggle",
    path: ["verboseLogging"],
    labelKey: "memoryPage.dreaming.verboseLogging.label",
    helpKey: "memoryPage.dreaming.verboseLogging.help",
  },
];

const DREAMING_PHASE_GROUPS: readonly DreamingFieldGroup[] = [
  {
    titleKey: "memoryPage.dreaming.phases.light.title",
    descriptionKey: "memoryPage.dreaming.phases.light.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "light", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
      },
      {
        kind: "number",
        path: ["phases", "light", "lookbackDays"],
        labelKey: "memoryPage.dreaming.phaseFields.lookbackDays",
        helpKey: "memoryPage.dreaming.phaseFields.lookbackDaysHelp",
      },
      {
        kind: "number",
        path: ["phases", "light", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
      },
      {
        kind: "number",
        path: ["phases", "light", "dedupeSimilarity"],
        labelKey: "memoryPage.dreaming.phaseFields.dedupeSimilarity",
        helpKey: "memoryPage.dreaming.phaseFields.dedupeSimilarityHelp",
        step: 0.01,
      },
    ],
  },
  {
    titleKey: "memoryPage.dreaming.phases.deep.title",
    descriptionKey: "memoryPage.dreaming.phases.deep.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "deep", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "minScore"],
        labelKey: "memoryPage.dreaming.phaseFields.minScore",
        helpKey: "memoryPage.dreaming.phaseFields.minScoreHelp",
        step: 0.01,
      },
      {
        kind: "number",
        path: ["phases", "deep", "minRecallCount"],
        labelKey: "memoryPage.dreaming.phaseFields.minRecallCount",
        helpKey: "memoryPage.dreaming.phaseFields.minRecallCountHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "minUniqueQueries"],
        labelKey: "memoryPage.dreaming.phaseFields.minUniqueQueries",
        helpKey: "memoryPage.dreaming.phaseFields.minUniqueQueriesHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "recencyHalfLifeDays"],
        labelKey: "memoryPage.dreaming.phaseFields.recencyHalfLifeDays",
        helpKey: "memoryPage.dreaming.phaseFields.recencyHalfLifeDaysHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "maxAgeDays"],
        labelKey: "memoryPage.dreaming.phaseFields.maxAgeDays",
        helpKey: "memoryPage.dreaming.phaseFields.maxAgeDaysHelp",
      },
      {
        kind: "number",
        path: ["phases", "deep", "maxPromotedSnippetTokens"],
        labelKey: "memoryPage.dreaming.phaseFields.maxPromotedSnippetTokens",
        helpKey: "memoryPage.dreaming.phaseFields.maxPromotedSnippetTokensHelp",
      },
    ],
  },
  {
    titleKey: "memoryPage.dreaming.phases.rem.title",
    descriptionKey: "memoryPage.dreaming.phases.rem.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "rem", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
      },
      {
        kind: "number",
        path: ["phases", "rem", "lookbackDays"],
        labelKey: "memoryPage.dreaming.phaseFields.lookbackDays",
        helpKey: "memoryPage.dreaming.phaseFields.lookbackDaysHelp",
      },
      {
        kind: "number",
        path: ["phases", "rem", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
      },
      {
        kind: "number",
        path: ["phases", "rem", "minPatternStrength"],
        labelKey: "memoryPage.dreaming.phaseFields.minPatternStrength",
        helpKey: "memoryPage.dreaming.phaseFields.minPatternStrengthHelp",
        step: 0.01,
      },
    ],
  },
];

const STORAGE_MODES = ["inline", "separate", "both"] as const;
type StorageMode = (typeof STORAGE_MODES)[number];

function readAtPath(root: Record<string, unknown> | null, path: readonly string[]): unknown {
  let current: Record<string, unknown> | null = root;
  for (const [index, key] of path.entries()) {
    if (!current) {
      return undefined;
    }
    const next = current[key];
    if (index === path.length - 1) {
      return next;
    }
    current = asConfigRecord(next);
  }
  return undefined;
}

function normalizeStorageMode(value: unknown): StorageMode {
  return STORAGE_MODES.find((mode) => mode === value) ?? "inline";
}

class MemoryDreamingSettings extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private selectedAgentId: string | null = null;

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
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

  private writePath(path: readonly string[]): Array<string | number> {
    return ["plugins", "entries", this.dreamingPluginId(), "config", "dreaming", ...path];
  }

  private patch(path: readonly string[], value: unknown) {
    const runtimeConfig = this.context.runtimeConfig;
    if (value === undefined) {
      runtimeConfig.removeFormValue(this.writePath(path));
      return;
    }
    runtimeConfig.patchForm(this.writePath(path), value);
  }

  private resolveAgentId(): string | null {
    const agentsList = this.context.agents.state.agentsList;
    const selectable = listSelectableAgents(agentsList?.agents ?? []);
    if (this.selectedAgentId && selectable.some((agent) => agent.id === this.selectedAgentId)) {
      return this.selectedAgentId;
    }
    return agentsList?.defaultId ?? selectable[0]?.id ?? null;
  }

  private renderField(spec: DreamingFieldSpec, dreaming: Record<string, unknown> | null) {
    const value = readAtPath(dreaming, spec.path);
    if (spec.kind === "toggle") {
      return renderSettingsToggleRow({
        title: t(spec.labelKey),
        description: t(spec.helpKey),
        checked: value === true,
        onChange: (checked) => this.patch(spec.path, checked),
      });
    }
    const text =
      spec.kind === "number"
        ? typeof value === "number"
          ? String(value)
          : ""
        : typeof value === "string"
          ? value
          : "";
    return renderSettingsRow({
      title: t(spec.labelKey),
      description: t(spec.helpKey),
      control: html`
        <input
          class="settings-input"
          type=${spec.kind === "number" ? "number" : "text"}
          step=${spec.kind === "number" && spec.step !== undefined ? String(spec.step) : nothing}
          spellcheck="false"
          aria-label=${t(spec.labelKey)}
          .value=${text}
          placeholder=${spec.kind === "text" && spec.placeholderKey ? t(spec.placeholderKey) : ""}
          @change=${(event: Event) => {
            const next = (event.currentTarget as HTMLInputElement).value.trim();
            if (!next) {
              this.patch(spec.path, undefined);
              return;
            }
            if (spec.kind === "number") {
              const parsed = Number(next);
              this.patch(spec.path, Number.isFinite(parsed) ? parsed : undefined);
              return;
            }
            this.patch(spec.path, next);
          }}
        />
      `,
    });
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
    const dreaming = this.dreamingConfig();
    const agentId = this.resolveAgentId();
    const storageMode = normalizeStorageMode(readAtPath(dreaming, ["storage", "mode"]));
    return html`
      <div class="settings-page">
        <p class="settings-page__intro">
          ${t("memoryPage.dreaming.intro", { plugin: this.dreamingPluginId() })}
        </p>
        ${renderSettingsSection(
          {
            title: t("memoryPage.dreaming.schedule.title"),
            description: t("memoryPage.dreaming.schedule.description"),
          },
          DREAMING_SCHEDULE_FIELDS.map((spec) => this.renderField(spec, dreaming)),
        )}
        ${renderSettingsSection(
          {
            title: t("memoryPage.dreaming.storage.title"),
            description: t("memoryPage.dreaming.storage.description"),
          },
          html`
            ${renderSettingsRow({
              title: t("memoryPage.dreaming.storage.modeLabel"),
              description: t("memoryPage.dreaming.storage.modeHelp"),
              stacked: true,
              control: renderSettingsSegmented<StorageMode>({
                value: storageMode,
                options: STORAGE_MODES.map((mode) => ({
                  value: mode,
                  label: t(`memoryPage.dreaming.storage.modes.${mode}`),
                })),
                ariaLabel: t("memoryPage.dreaming.storage.modeLabel"),
                onChange: (mode) => this.patch(["storage", "mode"], mode),
              }),
            })}
            ${renderSettingsToggleRow({
              title: t("memoryPage.dreaming.storage.separateReportsLabel"),
              description: t("memoryPage.dreaming.storage.separateReportsHelp"),
              checked: readAtPath(dreaming, ["storage", "separateReports"]) === true,
              onChange: (checked) => this.patch(["storage", "separateReports"], checked),
            })}
          `,
        )}
        ${DREAMING_PHASE_GROUPS.map((group) =>
          renderSettingsSection(
            { title: t(group.titleKey), description: t(group.descriptionKey) },
            group.fields.map((spec) => this.renderField(spec, dreaming)),
          ),
        )}
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
