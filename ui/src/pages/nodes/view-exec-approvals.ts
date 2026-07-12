// Control UI view renders nodes exec approvals screen content.
import { html, nothing } from "lit";
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
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t("nodes.execApprovals.title")}</div>
          <div class="card-sub">
            ${t("nodes.execApprovals.subtitlePrefix")}
            <span class="mono">exec host=gateway/node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.dirty || !targetReady || Boolean(state.nativePolicy)}
          @click=${state.onSave}
        >
          ${state.saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      ${renderExecApprovalsTarget(state)}
      ${!ready
        ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t("nodes.execApprovals.loadHint")}</div>
            <button class="btn" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
              ${state.loading ? t("common.loading") : t("common.loadApprovals")}
            </button>
          </div>`
        : state.nativePolicy
          ? renderNativeExecApprovals(state.nativePolicy)
          : html`
              ${renderExecApprovalsTabs(state)} ${renderExecApprovalsPolicy(state)}
              ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
                ? nothing
                : renderExecApprovalsAllowlist(state)}
            `}
    </section>
  `;
}

function renderNativeExecApprovals(snapshot: NativeExecApprovalsSnapshot) {
  const rules = snapshot.enabled && Array.isArray(snapshot.rules) ? snapshot.rules : [];
  const defaultAction = snapshot.enabled
    ? snapshot.defaultAction
    : (snapshot.message ?? "unavailable");
  return html`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.hostNativePolicy")}</div>
          <div class="list-sub">${t("nodes.execApprovals.hostNativeHint")}</div>
        </div>
        <div class="list-meta">
          <span class="badge">${t("nodes.execApprovals.native")}</span>
        </div>
      </div>
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.defaultAction")}</div>
          <div class="list-sub">${defaultAction}</div>
        </div>
        <div class="list-meta">
          ${t(rules.length === 1 ? "nodes.execApprovals.rule" : "nodes.execApprovals.rules", {
            count: String(rules.length),
          })}
        </div>
      </div>
      ${rules.map(
        (rule) => html`
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">${rule.pattern}</div>
              <div class="list-sub">
                ${rule.action} · ${rule.shells?.join(", ") || t("nodes.execApprovals.allShells")} ·
                ${rule.enabled === false
                  ? t("nodes.execApprovals.off")
                  : t("nodes.execApprovals.on")}
              </div>
              ${rule.description
                ? html`<div class="list-sub">${clampText(rule.description, 120)}</div>`
                : nothing}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";
  return html`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.target")}</div>
          <div class="list-sub">${t("nodes.execApprovals.targetHint")}</div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.execApprovals.host")}</span>
            <select
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
          </label>
          ${state.target === "node"
            ? html`
                <label class="field">
                  <span>${t("nodes.execApprovals.node")}</span>
                  <select
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
                </label>
              `
            : nothing}
        </div>
      </div>
      ${state.target === "node" && !hasNodes
        ? html` <div class="muted">${t("nodes.execApprovals.noNodes")}</div> `
        : nothing}
    </div>
  `;
}

function renderExecApprovalsTabs(state: ExecApprovalsState) {
  return html`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">${t("nodes.execApprovals.scope")}</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
            ? "active"
            : ""}"
          @click=${() => state.onSelectScope(EXEC_APPROVALS_DEFAULT_SCOPE)}
        >
          ${t("nodes.execApprovals.defaults")}
        </button>
        ${state.agents.map((agent) => {
          const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
          return html`
            <button
              class="btn btn--sm ${state.selectedScope === agent.id ? "active" : ""}"
              @click=${() => state.onSelectScope(agent.id)}
            >
              ${label}
            </button>
          `;
        })}
      </div>
    </div>
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
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.security")}</div>
          <div class="list-sub">
            ${isDefaults
              ? t("nodes.execApprovals.defaultSecurity")
              : t("nodes.execApprovals.defaultValue", { value: defaults.security })}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.execApprovals.mode")}</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "security"]);
                } else {
                  state.onPatch([...basePath, "security"], value);
                }
              }}
            >
              ${!isDefaults
                ? html`<option value="__default__" ?selected=${securityValue === "__default__"}>
                    ${t("nodes.execApprovals.useDefaultValue", { value: defaults.security })}
                  </option>`
                : nothing}
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${securityValue === option.value}>
                    ${t(option.labelKey)}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.ask")}</div>
          <div class="list-sub">
            ${isDefaults
              ? t("nodes.execApprovals.defaultPrompt")
              : t("nodes.execApprovals.defaultValue", { value: defaults.ask })}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.execApprovals.mode")}</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "ask"]);
                } else {
                  state.onPatch([...basePath, "ask"], value);
                }
              }}
            >
              ${!isDefaults
                ? html`<option value="__default__" ?selected=${askValue === "__default__"}>
                    ${t("nodes.execApprovals.useDefaultValue", { value: defaults.ask })}
                  </option>`
                : nothing}
              ${ASK_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${askValue === option.value}>
                    ${t(option.labelKey)}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.askFallback")}</div>
          <div class="list-sub">
            ${isDefaults
              ? t("nodes.execApprovals.promptUnavailable")
              : t("nodes.execApprovals.defaultValue", { value: defaults.askFallback })}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.execApprovals.fallback")}</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "askFallback"]);
                } else {
                  state.onPatch([...basePath, "askFallback"], value);
                }
              }}
            >
              ${!isDefaults
                ? html`<option value="__default__" ?selected=${askFallbackValue === "__default__"}>
                    ${t("nodes.execApprovals.useDefaultValue", { value: defaults.askFallback })}
                  </option>`
                : nothing}
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${askFallbackValue === option.value}>
                    ${t(option.labelKey)}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.execApprovals.autoAllowSkills")}</div>
          <div class="list-sub">
            ${isDefaults
              ? t("nodes.execApprovals.autoAllowSkillsHint")
              : autoIsDefault
                ? t("nodes.execApprovals.usingDefault", {
                    value: defaults.autoAllowSkills
                      ? t("nodes.execApprovals.on")
                      : t("nodes.execApprovals.off"),
                  })
                : t("nodes.execApprovals.override", {
                    value: autoEffective
                      ? t("nodes.execApprovals.on")
                      : t("nodes.execApprovals.off"),
                  })}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.execApprovals.enabled")}</span>
            <input
              type="checkbox"
              ?disabled=${state.disabled}
              .checked=${autoEffective}
              @change=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                state.onPatch([...basePath, "autoAllowSkills"], target.checked);
              }}
            />
          </label>
          ${!isDefaults && !autoIsDefault
            ? html`<button
                class="btn btn--sm"
                ?disabled=${state.disabled}
                @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
              >
                ${t("nodes.execApprovals.useDefault")}
              </button>`
            : nothing}
        </div>
      </div>
    </div>
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;
  return html`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">${t("nodes.execApprovals.allowlist")}</div>
        <div class="card-sub">${t("nodes.execApprovals.allowlistHint")}</div>
      </div>
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
    </div>
    <div class="list" style="margin-top: 12px;">
      ${entries.length === 0
        ? html` <div class="muted">${t("nodes.execApprovals.emptyAllowlist")}</div> `
        : entries.map((entry, index) => renderAllowlistEntry(state, entry, index))}
    </div>
  `;
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatRelativeTimestamp(entry.lastUsedAt) : t("common.never");
  const lastCommand = entry.lastUsedCommand ? clampText(entry.lastUsedCommand, 120) : null;
  const lastPath = entry.lastResolvedPath ? clampText(entry.lastResolvedPath, 120) : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          ${entry.pattern?.trim() ? entry.pattern : t("nodes.execApprovals.newPattern")}
        </div>
        <div class="list-sub">${t("nodes.execApprovals.lastUsed", { time: lastUsed })}</div>
        ${lastCommand ? html`<div class="list-sub mono">${lastCommand}</div>` : nothing}
        ${lastPath ? html`<div class="list-sub mono">${lastPath}</div>` : nothing}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>${t("nodes.execApprovals.pattern")}</span>
          <input
            type="text"
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
        </label>
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
      </div>
    </div>
  `;
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  return resolveNodeTargets(nodes, ["system.execApprovals.get", "system.execApprovals.set"]);
}
