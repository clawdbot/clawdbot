// Devices page renders its screen content.
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { parseNodeList } from "../../../../src/shared/node-list-parse.js";
import { resolveNodeIdFromCandidates } from "../../../../src/shared/node-match.js";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/devices.css";
import { renderExecApprovals, resolveExecApprovalsState } from "./view-exec-approvals.ts";
import { renderDeviceInventory } from "./view-inventory.ts";
import { resolveConfigAgents, resolveNodeTargets } from "./view-shared.ts";
import type { DevicesProps } from "./view.types.ts";

export function renderDevices(props: DevicesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  return renderSettingsPage(
    html`
      ${
        !props.canManagePairing || !props.canAdmin
          ? html`<div class="callout info" role="note">
              ${t(
                !props.canManagePairing && !props.canAdmin
                  ? "devices.readOnly.pairingAndAdminRequired"
                  : !props.canManagePairing
                    ? "devices.readOnly.pairingRequired"
                    : "devices.readOnly.adminRequired",
              )}
            </div>`
          : nothing
      }
      ${renderDeviceInventory(props)} ${renderExecApprovals(approvalsState)}
      ${renderBindings(bindingState)}
    `,
    { wide: true },
  );
}

type BindingAgent = BindingState["agents"][number];
type BindingState = ReturnType<typeof resolveBindingsState>;

function resolveBindingsState(props: DevicesProps) {
  return {
    ...props,
    ...resolveAgentBindings(props.configForm),
    ready: Boolean(props.configForm),
    disabled: !props.canAdmin || props.configSaving || props.configFormMode === "raw",
    nodes: resolveNodeTargets(props.nodes, ["system.run"]),
    inventory: parseNodeList({ nodes: props.nodes }),
  };
}

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const saveButton = html`
    <button
      class="btn"
      ?disabled=${state.disabled || !state.configDirty}
      @click=${state.onSaveBindings}
    >
      ${state.configSaving ? t("common.saving") : t("common.save")}
    </button>
  `;
  const rows = html`
    ${!state.canAdmin ? renderSettingsRow({ title: t("devices.readOnly.adminRequired") }) : nothing}
    ${
      state.configFormMode === "raw"
        ? renderSettingsRow({ title: t("devices.binding.formModeHint") })
        : nothing
    }
    ${
      !state.ready
        ? renderSettingsRow({
            title: t("devices.binding.loadConfigHint"),
            control: html`
              <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
                ${state.configLoading ? t("common.loading") : t("common.loadConfig")}
              </button>
            `,
          })
        : html`
            ${renderSettingsRow({
              title: t("devices.binding.defaultBinding"),
              description: supportsBinding
                ? t("devices.binding.defaultBindingHint")
                : html`${t("devices.binding.defaultBindingHint")} ${t("devices.binding.noNodes")}`,
              control: renderBindingSelect(null, state),
            })}
            ${
              state.agents.length === 0
                ? renderSettingsRow({ title: t("devices.binding.noAgents") })
                : state.agents.map((agent) => renderAgentBinding(agent, state))
            }
          `
    }
  `;
  return renderSettingsSection(
    {
      title: t("devices.binding.execNodeBinding"),
      description: t("devices.binding.execNodeBindingSubtitle"),
      actions: saveButton,
    },
    rows,
  );
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  return renderSettingsRow({
    title: label,
    description: html`
      ${agent.isDefault ? t("devices.binding.defaultAgent") : t("devices.binding.agent")} ·
      ${
        bindingValue === "__default__"
          ? t("devices.binding.usesDefault", {
              node: state.defaultBinding ?? t("devices.binding.any"),
            })
          : t("devices.binding.override", { node: agent.binding ?? "" })
      }
    `,
    control: renderBindingSelect(agent, state),
  });
}

function renderBindingSelect(agent: BindingAgent | null, state: BindingState) {
  const isDefault = agent === null;
  const sentinel = isDefault ? "" : "__default__";
  const selected = isDefault ? (state.defaultBinding ?? "") : (agent.binding ?? "__default__");
  let resolvedId: string | undefined;
  if (selected !== sentinel) {
    try {
      // Match the full inventory before capability filtering, as exec does;
      // an incapable node must not hide ambiguity or redirect an exact ID.
      resolvedId = resolveNodeIdFromCandidates(state.inventory, selected);
    } catch {
      // Unknown and ambiguous references remain visible without changing config.
    }
  }
  const options = state.nodes.map((node) => ({
    ...node,
    id: node.id === resolvedId ? selected : node.id,
    disabled: false,
  }));
  if (selected !== sentinel && !options.some((node) => node.id === selected)) {
    options.push({
      id: selected,
      label: `${selected} (${t("devices.binding.unavailable")})`,
      disabled: true,
    });
  }
  const onChange = (event: Event) => {
    const value = (event.target as HTMLSelectElement).value.trim();
    if (agent === null) {
      state.onBindDefault(value || null);
    } else {
      state.onBindAgent(agent.id, value === "__default__" ? null : value);
    }
  };
  // Lit sets select.value before updating its children; option selectedness
  // must also be retained when recovery inserts the configured option.
  return html`
    <select
      class="settings-select"
      aria-label=${t(isDefault ? "devices.binding.node" : "devices.binding.binding")}
      .value=${live(selected)}
      ?disabled=${state.disabled || state.nodes.length === 0}
      @change=${onChange}
    >
      <option value=${sentinel} ?selected=${selected === sentinel}>
        ${t(isDefault ? "devices.binding.anyNode" : "devices.binding.useDefault")}
      </option>
      ${repeat(
        options,
        (node) => node.id,
        (node) =>
          html`<option
            value=${node.id}
            ?selected=${selected === node.id}
            ?disabled=${node.disabled}
          >
            ${node.label}
          </option>`,
      )}
    </select>
  `;
}

function resolveAgentBindings(config: Record<string, unknown> | null) {
  const fallbackAgent = {
    id: "main",
    name: undefined,
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

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = (entry.record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    return {
      id: entry.id,
      name: entry.name,
      isDefault: entry.isDefault,
      binding,
    };
  });

  if (agents.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  return { defaultBinding, agents };
}
