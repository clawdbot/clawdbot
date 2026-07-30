// Nodes page renders its screen content.
import { html, nothing } from "lit";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/nodes.css";
import { renderExecApprovals, resolveExecApprovalsState } from "./view-exec-approvals.ts";
import { renderNodesInventory } from "./view-inventory.ts";
import { resolveConfigAgents, resolveNodeTargets, type NodeTargetOption } from "./view-shared.ts";
import type { NodesProps } from "./view.types.ts";

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  return renderSettingsPage(
    html`
      ${renderNodesInventory(props)} ${renderExecApprovals(approvalsState)}
      ${renderBindings(bindingState)}
    `,
    { wide: true },
  );
}

type BindingAgent = {
  id: string;
  name: string | undefined;
  index: number;
  isDefault: boolean;
  binding: string | null;
};

type BindingNode = NodeTargetOption;

type BindingState = {
  ready: boolean;
  disabled: boolean;
  configDirty: boolean;
  configLoading: boolean;
  configSaving: boolean;
  defaultBinding?: string | null;
  agents: BindingAgent[];
  nodes: BindingNode[];
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSave: () => void;
  onLoadConfig: () => void;
  formMode: "form" | "raw";
};

function resolveBindingsState(props: NodesProps): BindingState {
  const config = props.configForm;
  const nodes = resolveExecNodes(props.nodes);
  const { defaultBinding, agents } = resolveAgentBindings(config);
  const ready = Boolean(config);
  const disabled = props.configSaving || props.configFormMode === "raw";
  return {
    ready,
    disabled,
    configDirty: props.configDirty,
    configLoading: props.configLoading,
    configSaving: props.configSaving,
    defaultBinding,
    agents,
    nodes,
    onBindDefault: props.onBindDefault,
    onBindAgent: props.onBindAgent,
    onSave: props.onSaveBindings,
    onLoadConfig: props.onLoadConfig,
    formMode: props.configFormMode,
  };
}

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  const saveButton = html`
    <button class="btn" ?disabled=${state.disabled || !state.configDirty} @click=${state.onSave}>
      ${state.configSaving ? t("common.saving") : t("common.save")}
    </button>
  `;
  const rows = html`
    ${state.formMode === "raw"
      ? renderSettingsRow({ title: t("nodes.binding.formModeHint") })
      : nothing}
    ${!state.ready
      ? renderSettingsRow({
          title: t("nodes.binding.loadConfigHint"),
          control: html`
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? t("common.loading") : t("common.loadConfig")}
            </button>
          `,
        })
      : html`
          ${renderSettingsRow({
            title: t("nodes.binding.defaultBinding"),
            description: supportsBinding
              ? t("nodes.binding.defaultBindingHint")
              : html`${t("nodes.binding.defaultBindingHint")} ${t("nodes.binding.noNodes")}`,
            control: html`
              <select
                class="settings-select"
                aria-label=${t("nodes.binding.node")}
                ?disabled=${state.disabled || !supportsBinding}
                @change=${(event: Event) => {
                  const target = event.target as HTMLSelectElement;
                  const value = target.value.trim();
                  state.onBindDefault(value ? value : null);
                }}
              >
                <option value="" ?selected=${defaultValue === ""}>
                  ${t("nodes.binding.anyNode")}
                </option>
                ${state.nodes.map(
                  (node) =>
                    html`<option value=${node.id} ?selected=${defaultValue === node.id}>
                      ${node.label}
                    </option>`,
                )}
              </select>
            `,
          })}
          ${state.agents.length === 0
            ? renderSettingsRow({ title: t("nodes.binding.noAgents") })
            : state.agents.map((agent) => renderAgentBinding(agent, state))}
        `}
  `;
  return renderSettingsSection(
    {
      title: t("nodes.binding.execNodeBinding"),
      description: t("nodes.binding.execNodeBindingSubtitle"),
      actions: saveButton,
    },
    rows,
  );
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  const supportsBinding = state.nodes.length > 0;
  return renderSettingsRow({
    title: label,
    description: html`
      ${agent.isDefault ? t("nodes.binding.defaultAgent") : t("nodes.binding.agent")} ·
      ${bindingValue === "__default__"
        ? t("nodes.binding.usesDefault", {
            node: state.defaultBinding ?? t("nodes.binding.any"),
          })
        : t("nodes.binding.override", { node: agent.binding ?? "" })}
    `,
    control: html`
      <select
        class="settings-select"
        aria-label=${t("nodes.binding.binding")}
        ?disabled=${state.disabled || !supportsBinding}
        @change=${(event: Event) => {
          const target = event.target as HTMLSelectElement;
          const value = target.value.trim();
          state.onBindAgent(agent.index, value === "__default__" ? null : value);
        }}
      >
        <option value="__default__" ?selected=${bindingValue === "__default__"}>
          ${t("nodes.binding.useDefault")}
        </option>
        ${state.nodes.map(
          (node) =>
            html`<option value=${node.id} ?selected=${bindingValue === node.id}>
              ${node.label}
            </option>`,
        )}
      </select>
    `,
  });
}

function resolveExecNodes(nodes: Array<Record<string, unknown>>): BindingNode[] {
  return resolveNodeTargets(nodes, ["system.run"]);
}

function resolveAgentBindings(config: Record<string, unknown> | null): {
  defaultBinding?: string | null;
  agents: BindingAgent[];
} {
  const fallbackAgent: BindingAgent = {
    id: "main",
    name: undefined,
    index: 0,
    isDefault: true,
    binding: null,
  };
  if (!config || typeof config !== "object") {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = (config.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  const defaultBinding =
    typeof exec.node === "string" && exec.node.trim() ? exec.node.trim() : null;

  const agentsNode = (config.agents ?? {}) as Record<string, unknown>;
  if (!Array.isArray(agentsNode.list) || agentsNode.list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = (entry.record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    return {
      id: entry.id,
      name: entry.name,
      index: entry.index,
      isDefault: entry.isDefault,
      binding,
    };
  });

  if (agents.length === 0) {
    agents.push(fallbackAgent);
  }

  return { defaultBinding, agents };
}
