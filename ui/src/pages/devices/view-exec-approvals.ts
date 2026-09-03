// Control UI view renders nodes exec approvals screen content.
import { html, nothing } from "lit";
import "../../components/agent-select-registration.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { clampText, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  isNativeExecApprovalsSnapshot,
  type ExecApprovalsAllowlistEntry,
  type ExecApprovalsFile,
  type ExecApprovalsResolvedDefaults,
  type ExecAsk,
  type ExecSecurity,
  type NativeExecApprovalsSnapshot,
} from "../../lib/nodes/index.ts";
import {
  resolveConfigAgents as resolveSharedConfigAgents,
  resolveNodeTargets,
  type NodeTargetOption,
} from "./view-shared.ts";
import type { DevicesProps } from "./view.types.ts";

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsTargetNode = NodeTargetOption;

type ExecApprovalsState = {
  ready: boolean;
  disabled: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  form: ExecApprovalsFile | null;
  nativePolicy: NativeExecApprovalsSnapshot | null;
  defaults: ExecApprovalsResolvedDefaults;
  selectedScope: string;
  selectedAgent: Record<string, unknown> | null;
  agents: ExecApprovalsAgentOption[];
  allowlist: ExecApprovalsAllowlistEntry[];
  target: "gateway" | "node";
  targetNodeId: string | null;
  targetNodes: ExecApprovalsTargetNode[];
  onSelectScope: (agentId: string) => void;
  onSelectTarget: (kind: "gateway" | "node", nodeId: string | null) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
  onLoad: () => void;
  onSave: () => void;
  canAdmin: boolean;
};

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; labelKey: string }> = [
  { value: "deny", labelKey: "devices.execApprovals.options.deny" },
  { value: "allowlist", labelKey: "devices.execApprovals.options.allowlist" },
  { value: "full", labelKey: "devices.execApprovals.options.full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; labelKey: string }> = [
  { value: "off", labelKey: "devices.execApprovals.options.off" },
  { value: "on-miss", labelKey: "devices.execApprovals.options.onMiss" },
  { value: "always", labelKey: "devices.execApprovals.options.always" },
];

function normalizeSecurity(value?: string): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return "on-miss";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
  reported: ExecApprovalsResolvedDefaults | undefined,
  includeWildcard: boolean,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  const wildcard = includeWildcard ? (form?.agents?.["*"] ?? {}) : {};
  return {
    security: normalizeSecurity(wildcard.security ?? defaults.security ?? reported?.security),
    ask: normalizeAsk(wildcard.ask ?? defaults.ask ?? reported?.ask),
    askFallback: normalizeSecurity(
      wildcard.askFallback ?? defaults.askFallback ?? reported?.askFallback ?? "deny",
    ),
    autoAllowSkills:
      wildcard.autoAllowSkills ?? defaults.autoAllowSkills ?? reported?.autoAllowSkills ?? false,
  };
}

function resolveConfigAgents(config: Record<string, unknown> | null): ExecApprovalsAgentOption[] {
  return resolveSharedConfigAgents(config).map((entry) => ({
    id: entry.id,
    name: entry.name,
    isDefault: entry.isDefault,
  }));
}

function resolveExecApprovalsAgents(
  config: Record<string, unknown> | null,
  form: ExecApprovalsFile | null,
): ExecApprovalsAgentOption[] {
  const configAgents = resolveConfigAgents(config);
  const approvalsAgents = Object.keys(form?.agents ?? {});
  const merged = new Map<string, ExecApprovalsAgentOption>();
  configAgents.forEach((agent) => merged.set(agent.id, agent));
  approvalsAgents.forEach((id) => {
    if (merged.has(id)) {
      return;
    }
    merged.set(id, { id });
  });
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) {
      return -1;
    }
    if (!a.isDefault && b.isDefault) {
      return 1;
    }
    const aLabel = a.name?.trim() ? a.name : a.id;
    const bLabel = b.name?.trim() ? b.name : b.id;
    return aLabel.localeCompare(bLabel);
  });
  return agents;
}

function resolveExecApprovalsScope(
  selected: string | null,
  agents: ExecApprovalsAgentOption[],
): string {
  if (selected === EXEC_APPROVALS_DEFAULT_SCOPE) {
    return EXEC_APPROVALS_DEFAULT_SCOPE;
  }
  if (selected && agents.some((agent) => agent.id === selected)) {
    return selected;
  }
  return EXEC_APPROVALS_DEFAULT_SCOPE;
}

export function resolveExecApprovalsState(props: DevicesProps): ExecApprovalsState {
  const snapshot = props.execApprovalsSnapshot;
  const nativePolicy = isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const fileSnapshot = snapshot && !isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const form = nativePolicy ? null : (props.execApprovalsForm ?? fileSnapshot?.file ?? null);
  const ready = Boolean(form || nativePolicy);
  const agents = resolveExecApprovalsAgents(props.configForm, form);
  const targetNodes = resolveExecApprovalsNodes(props.nodes);
  const target = props.execApprovalsTarget;
  let targetNodeId =
    target === "node" && props.execApprovalsTargetNodeId ? props.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const defaults = resolveExecApprovalsDefaults(
    form,
    fileSnapshot?.resolvedDefaults,
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE,
  );
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? (((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ?? null)
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ?? [])
    : [];
  return {
    ready,
    disabled: !props.canAdmin || props.execApprovalsSaving || props.execApprovalsLoading,
    dirty: props.execApprovalsDirty,
    loading: props.execApprovalsLoading,
    saving: props.execApprovalsSaving,
    form,
    nativePolicy,
    defaults,
    selectedScope,
    selectedAgent,
    agents,
    allowlist,
    target,
    targetNodeId,
    targetNodes,
    onSelectScope: props.onExecApprovalsSelectAgent,
    onSelectTarget: props.onExecApprovalsTargetChange,
    onPatch: props.onExecApprovalsPatch,
    onRemove: props.onExecApprovalsRemove,
    onLoad: props.onLoadExecApprovals,
    onSave: props.onSaveExecApprovals,
    canAdmin: props.canAdmin,
  };
}

export function renderExecApprovals(state: ExecApprovalsState) {
  const ready = state.ready;
  const targetReady = state.target !== "node" || Boolean(state.targetNodeId);
  const saveButton = html`
    <button
      class="btn"
      ?disabled=${state.disabled || !state.dirty || !targetReady || Boolean(state.nativePolicy)}
      @click=${state.onSave}
    >
      ${state.saving ? t("common.saving") : t("common.save")}
    </button>
  `;
  const rows = html`
    ${!state.canAdmin
      ? renderSettingsRow({ title: t("devices.readOnly.adminRequired") })
      : html`
          ${renderExecApprovalsTarget(state)}
          ${!ready
            ? renderSettingsRow({
                title: t("devices.execApprovals.loadHint"),
                control: html`
                  <button
                    class="btn"
                    ?disabled=${state.loading || !targetReady}
                    @click=${state.onLoad}
                  >
                    ${state.loading ? t("common.loading") : t("common.loadApprovals")}
                  </button>
                `,
              })
            : state.nativePolicy
              ? renderNativeExecApprovals(state.nativePolicy)
              : html`${renderExecApprovalsScope(state)} ${renderExecApprovalsPolicy(state)}`}
        `}
  `;
  return html`
    ${renderSettingsSection(
      {
        title: t("devices.execApprovals.title"),
        description: html`
          ${t("devices.execApprovals.subtitlePrefix")}
          <span class="mono">exec host=gateway/node</span>.
        `,
        actions: saveButton,
      },
      rows,
    )}
    ${state.canAdmin &&
    ready &&
    !state.nativePolicy &&
    state.selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? renderExecApprovalsAllowlist(state)
      : nothing}
  `;
}

function renderNativeExecApprovals(snapshot: NativeExecApprovalsSnapshot) {
  const rules = snapshot.enabled && Array.isArray(snapshot.rules) ? snapshot.rules : [];
  const defaultAction = snapshot.enabled
    ? snapshot.defaultAction
    : (snapshot.message ?? "unavailable");
  return html`
    ${renderSettingsRow({
      title: t("devices.execApprovals.hostNativePolicy"),
      description: t("devices.execApprovals.hostNativeHint"),
      control: renderSettingsValue(t("devices.execApprovals.native")),
    })}
    ${renderSettingsRow({
      title: t("devices.execApprovals.defaultAction"),
      description: defaultAction,
      control: renderSettingsValue(
        t(rules.length === 1 ? "devices.execApprovals.rule" : "devices.execApprovals.rules", {
          count: String(rules.length),
        }),
      ),
    })}
    ${rules.map((rule) =>
      renderSettingsRow({
        title: rule.pattern,
        description: html`
          ${rule.action} · ${rule.shells?.join(", ") || t("devices.execApprovals.allShells")} ·
          ${rule.enabled === false ? t("devices.execApprovals.off") : t("devices.execApprovals.on")}
          ${rule.description ? html`<br />${clampText(rule.description, 120)}` : nothing}
        `,
      }),
    )}
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";
  return html`
    ${renderSettingsRow({
      title: t("devices.execApprovals.target"),
      description: t("devices.execApprovals.targetHint"),
      control: html`
        <select
          class="settings-select"
          aria-label=${t("devices.execApprovals.host")}
          ?disabled=${state.disabled}
          @change=${(event: Event) => {
            const target = event.target as HTMLSelectElement;
            const value = target.value;
            if (value === "node") {
              const first = state.targetNodes[0]?.id ?? null;
              state.onSelectTarget("node", nodeValue || first);
            } else {
              state.onSelectTarget("gateway", null);
            }
          }}
        >
          <option value="gateway" ?selected=${state.target === "gateway"}>
            ${t("devices.execApprovals.gateway")}
          </option>
          <option value="node" ?selected=${state.target === "node"}>
            ${t("devices.execApprovals.node")}
          </option>
        </select>
      `,
    })}
    ${state.target === "node"
      ? renderSettingsRow({
          title: t("devices.execApprovals.node"),
          description: hasNodes ? undefined : t("devices.execApprovals.noNodes"),
          control: html`
            <select
              class="settings-select"
              aria-label=${t("devices.execApprovals.node")}
              ?disabled=${state.disabled || !hasNodes}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value.trim();
                state.onSelectTarget("node", value ? value : null);
              }}
            >
              <option value="" ?selected=${nodeValue === ""}>
                ${t("devices.execApprovals.selectNode")}
              </option>
              ${state.targetNodes.map(
                (node) =>
                  html`<option value=${node.id} ?selected=${nodeValue === node.id}>
                    ${node.label}
                  </option>`,
              )}
            </select>
          `,
        })
      : nothing}
  `;
}

function renderExecApprovalsScope(state: ExecApprovalsState) {
  const options = [
    {
      value: EXEC_APPROVALS_DEFAULT_SCOPE,
      label: t("devices.execApprovals.defaults"),
      icon: icons.settings,
    },
    ...state.agents.map((agent) => ({
      value: agent.id,
      label: agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id,
      agent: { id: agent.id, ...(agent.name ? { name: agent.name } : {}) },
      badge: agent.isDefault ? t("agents.default") : undefined,
    })),
  ];
  return renderSettingsRow({
    title: t("devices.execApprovals.scope"),
    stacked: true,
    control: html`
      <openclaw-agent-select
        class="agent-select--settings"
        .options=${options}
        .value=${state.selectedScope}
        .accessibleLabel=${t("devices.execApprovals.scope")}
        .disabled=${state.disabled}
        .onSelect=${state.onSelectScope}
      ></openclaw-agent-select>
    `,
  });
}

function renderPolicySelect(
  state: ExecApprovalsState,
  options: {
    key: "security" | "ask" | "askFallback";
    ariaLabel: string;
    values: Array<{ value: string; labelKey: string }>;
    currentValue: string;
    defaultValue: string;
    isDefaults: boolean;
    basePath: Array<string | number>;
  },
) {
  return html`
    <select
      class="settings-select"
      aria-label=${options.ariaLabel}
      ?disabled=${state.disabled}
      @change=${(event: Event) => {
        const target = event.target as HTMLSelectElement;
        const value = target.value;
        if (!options.isDefaults && value === "__default__") {
          state.onRemove([...options.basePath, options.key]);
        } else {
          state.onPatch([...options.basePath, options.key], value);
        }
      }}
    >
      ${!options.isDefaults
        ? html`<option value="__default__" ?selected=${options.currentValue === "__default__"}>
            ${t("devices.execApprovals.useDefaultValue", { value: options.defaultValue })}
          </option>`
        : nothing}
      ${options.values.map(
        (option) =>
          html`<option value=${option.value} ?selected=${options.currentValue === option.value}>
            ${t(option.labelKey)}
          </option>`,
      )}
    </select>
  `;
}

function renderExecApprovalsPolicy(state: ExecApprovalsState) {
  const isDefaults = state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE;
  const defaults = state.defaults;
  const agent = state.selectedAgent ?? {};
  const basePath = isDefaults ? ["defaults"] : ["agents", state.selectedScope];
  const agentSecurity = typeof agent.security === "string" ? agent.security : undefined;
  const agentAsk = typeof agent.ask === "string" ? agent.ask : undefined;
  const agentAskFallback = typeof agent.askFallback === "string" ? agent.askFallback : undefined;
  const securityValue = isDefaults ? defaults.security : (agentSecurity ?? "__default__");
  const askValue = isDefaults ? defaults.ask : (agentAsk ?? "__default__");
  const askFallbackValue = isDefaults ? defaults.askFallback : (agentAskFallback ?? "__default__");
  const autoOverride =
    typeof agent.autoAllowSkills === "boolean" ? agent.autoAllowSkills : undefined;
  const autoEffective = autoOverride ?? defaults.autoAllowSkills;
  const autoIsDefault = autoOverride == null;

  return html`
    ${renderSettingsRow({
      title: t("devices.execApprovals.security"),
      description: isDefaults
        ? t("devices.execApprovals.defaultSecurity")
        : t("devices.execApprovals.defaultValue", { value: defaults.security }),
      control: renderPolicySelect(state, {
        key: "security",
        ariaLabel: t("devices.execApprovals.mode"),
        values: SECURITY_OPTIONS,
        currentValue: securityValue,
        defaultValue: defaults.security,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("devices.execApprovals.ask"),
      description: isDefaults
        ? t("devices.execApprovals.defaultPrompt")
        : t("devices.execApprovals.defaultValue", { value: defaults.ask }),
      control: renderPolicySelect(state, {
        key: "ask",
        ariaLabel: t("devices.execApprovals.mode"),
        values: ASK_OPTIONS,
        currentValue: askValue,
        defaultValue: defaults.ask,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("devices.execApprovals.askFallback"),
      description: isDefaults
        ? t("devices.execApprovals.promptUnavailable")
        : t("devices.execApprovals.defaultValue", { value: defaults.askFallback }),
      control: renderPolicySelect(state, {
        key: "askFallback",
        ariaLabel: t("devices.execApprovals.fallback"),
        values: SECURITY_OPTIONS,
        currentValue: askFallbackValue,
        defaultValue: defaults.askFallback,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("devices.execApprovals.autoAllowSkills"),
      description: isDefaults
        ? t("devices.execApprovals.autoAllowSkillsHint")
        : autoIsDefault
          ? t("devices.execApprovals.usingDefault", {
              value: defaults.autoAllowSkills
                ? t("devices.execApprovals.on")
                : t("devices.execApprovals.off"),
            })
          : t("devices.execApprovals.override", {
              value: autoEffective ? t("devices.execApprovals.on") : t("devices.execApprovals.off"),
            }),
      control: html`
        ${!isDefaults && !autoIsDefault
          ? html`<button
              class="btn btn--sm"
              ?disabled=${state.disabled}
              @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
            >
              ${t("devices.execApprovals.useDefault")}
            </button>`
          : nothing}
        ${renderSettingsToggle({
          checked: autoEffective,
          disabled: state.disabled,
          ariaLabel: t("devices.execApprovals.autoAllowSkills"),
          onChange: (checked) => state.onPatch([...basePath, "autoAllowSkills"], checked),
        })}
      `,
    })}
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;
  return renderSettingsSection(
    {
      title: t("devices.execApprovals.allowlist"),
      description: t("devices.execApprovals.allowlistHint"),
      actions: html`
        <button
          class="btn btn--sm"
          ?disabled=${state.disabled}
          @click=${() => {
            const next = [...entries, { pattern: "" }];
            state.onPatch(allowlistPath, next);
          }}
        >
          ${t("devices.execApprovals.addPattern")}
        </button>
      `,
    },
    entries.length === 0
      ? renderSettingsEmpty(t("devices.execApprovals.emptyAllowlist"))
      : entries.map((entry, index) => renderAllowlistEntry(state, entry, index)),
  );
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatRelativeTimestamp(entry.lastUsedAt) : t("common.never");
  const lastCommand = entry.lastUsedCommand ? clampText(entry.lastUsedCommand, 120) : null;
  const lastPath = entry.lastResolvedPath ? clampText(entry.lastResolvedPath, 120) : null;
  return renderSettingsRow({
    title: entry.pattern?.trim() ? entry.pattern : t("devices.execApprovals.newPattern"),
    description: html`
      ${t("devices.execApprovals.lastUsed", { time: lastUsed })}
      ${lastCommand ? html`<br /><span class="mono">${lastCommand}</span>` : nothing}
      ${lastPath ? html`<br /><span class="mono">${lastPath}</span>` : nothing}
    `,
    control: html`
      <input
        class="settings-input"
        type="text"
        aria-label=${t("devices.execApprovals.pattern")}
        .value=${entry.pattern ?? ""}
        ?disabled=${state.disabled}
        @input=${(event: Event) => {
          const target = event.target as HTMLInputElement;
          state.onPatch(
            ["agents", state.selectedScope, "allowlist", index, "pattern"],
            target.value,
          );
        }}
      />
      <button
        class="btn btn--sm danger"
        ?disabled=${state.disabled}
        @click=${() => {
          if (state.allowlist.length <= 1) {
            state.onRemove(["agents", state.selectedScope, "allowlist"]);
            return;
          }
          state.onRemove(["agents", state.selectedScope, "allowlist", index]);
        }}
      >
        ${t("devices.execApprovals.remove")}
      </button>
    `,
  });
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  return resolveNodeTargets(nodes, ["system.execApprovals.get", "system.execApprovals.set"]);
}
