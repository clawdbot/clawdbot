// Control UI view renders nodes exec approvals screen content.
import { html, nothing } from "lit";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsToggle,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { clampText, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  isNativeExecApprovalsSnapshot,
  type ExecApprovalsAllowlistEntry,
  type ExecApprovalsFile,
  type NativeExecApprovalsSnapshot,
} from "../../lib/nodes/index.ts";
import {
  resolveConfigAgents as resolveSharedConfigAgents,
  resolveNodeTargets,
  type NodeTargetOption,
} from "./view-shared.ts";
import type { NodesProps } from "./view.types.ts";

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";

type ExecApprovalsResolvedDefaults = {
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecSecurity;
  autoAllowSkills: boolean;
};

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
};

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; labelKey: string }> = [
  { value: "deny", labelKey: "nodes.execApprovals.options.deny" },
  { value: "allowlist", labelKey: "nodes.execApprovals.options.allowlist" },
  { value: "full", labelKey: "nodes.execApprovals.options.full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; labelKey: string }> = [
  { value: "off", labelKey: "nodes.execApprovals.options.off" },
  { value: "on-miss", labelKey: "nodes.execApprovals.options.onMiss" },
  { value: "always", labelKey: "nodes.execApprovals.options.always" },
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
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  return {
    security: normalizeSecurity(defaults.security),
    ask: normalizeAsk(defaults.ask),
    askFallback: normalizeSecurity(defaults.askFallback ?? "deny"),
    autoAllowSkills: defaults.autoAllowSkills ?? false,
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

export function resolveExecApprovalsState(props: NodesProps): ExecApprovalsState {
  const snapshot = props.execApprovalsSnapshot;
  const nativePolicy = isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const fileSnapshot = snapshot && !isNativeExecApprovalsSnapshot(snapshot) ? snapshot : null;
  const form = nativePolicy ? null : (props.execApprovalsForm ?? fileSnapshot?.file ?? null);
  const ready = Boolean(form || nativePolicy);
  const defaults = resolveExecApprovalsDefaults(form);
  const agents = resolveExecApprovalsAgents(props.configForm, form);
  const targetNodes = resolveExecApprovalsNodes(props.nodes);
  const target = props.execApprovalsTarget;
  let targetNodeId =
    target === "node" && props.execApprovalsTargetNodeId ? props.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? (((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ?? null)
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ?? [])
    : [];
  return {
    ready,
    disabled: props.execApprovalsSaving || props.execApprovalsLoading,
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
    ${renderExecApprovalsTarget(state)}
    ${!ready
      ? renderSettingsRow({
          title: t("nodes.execApprovals.loadHint"),
          control: html`
            <button class="btn" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
              ${state.loading ? t("common.loading") : t("common.loadApprovals")}
            </button>
          `,
        })
      : state.nativePolicy
        ? renderNativeExecApprovals(state.nativePolicy)
        : html`${renderExecApprovalsScope(state)} ${renderExecApprovalsPolicy(state)}`}
  `;
  return html`
    ${renderSettingsSection(
      {
        title: t("nodes.execApprovals.title"),
        description: html`
          ${t("nodes.execApprovals.subtitlePrefix")}
          <span class="mono">exec host=gateway/node</span>.
        `,
        actions: saveButton,
      },
      rows,
    )}
    ${ready && !state.nativePolicy && state.selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
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
      title: t("nodes.execApprovals.hostNativePolicy"),
      description: t("nodes.execApprovals.hostNativeHint"),
      control: renderSettingsValue(t("nodes.execApprovals.native")),
    })}
    ${renderSettingsRow({
      title: t("nodes.execApprovals.defaultAction"),
      description: defaultAction,
      control: renderSettingsValue(
        t(rules.length === 1 ? "nodes.execApprovals.rule" : "nodes.execApprovals.rules", {
          count: String(rules.length),
        }),
      ),
    })}
    ${rules.map((rule) =>
      renderSettingsRow({
        title: rule.pattern,
        description: html`
          ${rule.action} · ${rule.shells?.join(", ") || t("nodes.execApprovals.allShells")} ·
          ${rule.enabled === false ? t("nodes.execApprovals.off") : t("nodes.execApprovals.on")}
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
      title: t("nodes.execApprovals.target"),
      description: t("nodes.execApprovals.targetHint"),
      control: html`
        <select
          class="settings-select"
          aria-label=${t("nodes.execApprovals.host")}
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
            ${t("nodes.execApprovals.gateway")}
          </option>
          <option value="node" ?selected=${state.target === "node"}>
            ${t("nodes.execApprovals.node")}
          </option>
        </select>
      `,
    })}
    ${state.target === "node"
      ? renderSettingsRow({
          title: t("nodes.execApprovals.node"),
          description: hasNodes ? undefined : t("nodes.execApprovals.noNodes"),
          control: html`
            <select
              class="settings-select"
              aria-label=${t("nodes.execApprovals.node")}
              ?disabled=${state.disabled || !hasNodes}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value.trim();
                state.onSelectTarget("node", value ? value : null);
              }}
            >
              <option value="" ?selected=${nodeValue === ""}>
                ${t("nodes.execApprovals.selectNode")}
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
    { value: EXEC_APPROVALS_DEFAULT_SCOPE, label: t("nodes.execApprovals.defaults") },
    ...state.agents.map((agent) => ({
      value: agent.id,
      label: agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id,
    })),
  ];
  return renderSettingsRow({
    title: t("nodes.execApprovals.scope"),
    stacked: true,
    control: renderSettingsSegmented({
      value: state.selectedScope,
      options,
      onChange: (value) => state.onSelectScope(value),
    }),
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
            ${t("nodes.execApprovals.useDefaultValue", { value: options.defaultValue })}
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
      title: t("nodes.execApprovals.security"),
      description: isDefaults
        ? t("nodes.execApprovals.defaultSecurity")
        : t("nodes.execApprovals.defaultValue", { value: defaults.security }),
      control: renderPolicySelect(state, {
        key: "security",
        ariaLabel: t("nodes.execApprovals.mode"),
        values: SECURITY_OPTIONS,
        currentValue: securityValue,
        defaultValue: defaults.security,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("nodes.execApprovals.ask"),
      description: isDefaults
        ? t("nodes.execApprovals.defaultPrompt")
        : t("nodes.execApprovals.defaultValue", { value: defaults.ask }),
      control: renderPolicySelect(state, {
        key: "ask",
        ariaLabel: t("nodes.execApprovals.mode"),
        values: ASK_OPTIONS,
        currentValue: askValue,
        defaultValue: defaults.ask,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("nodes.execApprovals.askFallback"),
      description: isDefaults
        ? t("nodes.execApprovals.promptUnavailable")
        : t("nodes.execApprovals.defaultValue", { value: defaults.askFallback }),
      control: renderPolicySelect(state, {
        key: "askFallback",
        ariaLabel: t("nodes.execApprovals.fallback"),
        values: SECURITY_OPTIONS,
        currentValue: askFallbackValue,
        defaultValue: defaults.askFallback,
        isDefaults,
        basePath,
      }),
    })}
    ${renderSettingsRow({
      title: t("nodes.execApprovals.autoAllowSkills"),
      description: isDefaults
        ? t("nodes.execApprovals.autoAllowSkillsHint")
        : autoIsDefault
          ? t("nodes.execApprovals.usingDefault", {
              value: defaults.autoAllowSkills
                ? t("nodes.execApprovals.on")
                : t("nodes.execApprovals.off"),
            })
          : t("nodes.execApprovals.override", {
              value: autoEffective ? t("nodes.execApprovals.on") : t("nodes.execApprovals.off"),
            }),
      control: html`
        ${!isDefaults && !autoIsDefault
          ? html`<button
              class="btn btn--sm"
              ?disabled=${state.disabled}
              @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
            >
              ${t("nodes.execApprovals.useDefault")}
            </button>`
          : nothing}
        ${renderSettingsToggle({
          checked: autoEffective,
          disabled: state.disabled,
          ariaLabel: t("nodes.execApprovals.autoAllowSkills"),
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
      title: t("nodes.execApprovals.allowlist"),
      description: t("nodes.execApprovals.allowlistHint"),
      actions: html`
        <button
          class="btn btn--sm"
          ?disabled=${state.disabled}
          @click=${() => {
            const next = [...entries, { pattern: "" }];
            state.onPatch(allowlistPath, next);
          }}
        >
          ${t("nodes.execApprovals.addPattern")}
        </button>
      `,
    },
    entries.length === 0
      ? renderSettingsEmpty(t("nodes.execApprovals.emptyAllowlist"))
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
    title: entry.pattern?.trim() ? entry.pattern : t("nodes.execApprovals.newPattern"),
    description: html`
      ${t("nodes.execApprovals.lastUsed", { time: lastUsed })}
      ${lastCommand ? html`<br /><span class="mono">${lastCommand}</span>` : nothing}
      ${lastPath ? html`<br /><span class="mono">${lastPath}</span>` : nothing}
    `,
    control: html`
      <input
        class="settings-input"
        type="text"
        aria-label=${t("nodes.execApprovals.pattern")}
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
        ${t("nodes.execApprovals.remove")}
      </button>
    `,
  });
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  return resolveNodeTargets(nodes, ["system.execApprovals.get", "system.execApprovals.set"]);
}
