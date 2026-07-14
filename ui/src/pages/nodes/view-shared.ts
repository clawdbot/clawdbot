// Nodes page owns these pure view helpers.
import { html, type TemplateResult } from "lit";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { icons } from "../../components/icons.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export type NodeTargetOption = {
  id: string;
  label: string;
};

type ConfigAgentOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  index: number;
  record: Record<string, unknown>;
};

export function resolveConfigAgents(config: Record<string, unknown> | null): ConfigAgentOption[] {
  const agentsNode = (config?.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  const agents: ConfigAgentOption[] = [];

  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = normalizeOptionalString(record.id) ?? "";
    if (!id) {
      return;
    }
    const name = normalizeOptionalString(record.name);
    const isDefault = record.default === true;
    agents.push({ id, name, isDefault, index, record });
  });

  return agents;
}

export function resolveNodeTargets(
  nodes: Array<Record<string, unknown>>,
  requiredCommands: string[],
): NodeTargetOption[] {
  const required = new Set(requiredCommands);
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some((cmd) => required.has(String(cmd)));
    if (!supports) {
      continue;
    }

    const nodeId = normalizeOptionalString(node.nodeId) ?? "";
    if (!nodeId) {
      continue;
    }
    const displayName = normalizeOptionalString(node.displayName) ?? nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }

  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

type DeviceIconSource = {
  clientId?: string;
  clientMode?: string;
  platform?: string;
};

const MOBILE_PLATFORM_PATTERN = /\b(ios|ipados|watchos|android|iphone|ipad)\b/;
const MOBILE_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.WATCHOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);
const BROWSER_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.CONTROL_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT_UI,
  GATEWAY_CLIENT_IDS.WEBCHAT,
]);
const TERMINAL_CLIENT_MODES: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_MODES.CLI,
  GATEWAY_CLIENT_MODES.BACKEND,
  GATEWAY_CLIENT_MODES.PROBE,
  GATEWAY_CLIENT_MODES.TEST,
]);
// The TUI connects with mode "ui"; only its client id marks it as a terminal.
const TERMINAL_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.CLI,
  GATEWAY_CLIENT_IDS.TUI,
]);

/** Rough form-factor icon: phone, browser, terminal, or desktop machine. */
export function deviceIcon(source: DeviceIconSource): TemplateResult {
  const platform = source.platform?.trim().toLowerCase() ?? "";
  const clientId = source.clientId?.trim().toLowerCase() ?? "";
  const mode = source.clientMode?.trim().toLowerCase() ?? "";
  if (MOBILE_PLATFORM_PATTERN.test(platform) || MOBILE_CLIENT_IDS.has(clientId)) {
    return icons.smartphone;
  }
  if (BROWSER_CLIENT_IDS.has(clientId) || mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return icons.globe;
  }
  if (TERMINAL_CLIENT_MODES.has(mode) || TERMINAL_CLIENT_IDS.has(clientId)) {
    return icons.terminal;
  }
  return icons.monitor;
}

/* Connectivity state lives in the row's renderSettingsStatus dot + text, so
   the tile stays a purely decorative form-factor glyph. */
export function renderDeviceTile(icon: TemplateResult) {
  return html`
    <div class="nodes-entry__tile" aria-hidden="true">
      <span class="nodes-entry__tile-icon">${icon}</span>
    </div>
  `;
}
