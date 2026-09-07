// Devices page owns these pure view helpers.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, type TemplateResult } from "lit";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { deviceIcons } from "../../components/icons-devices.ts";
import { icons } from "../../components/icons.ts";
import { resolveMacFormFactor } from "../../lib/mac-form-factor.ts";

export type NodeTargetOption = {
  id: string;
  label: string;
};

type ConfigAgentOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  record: Record<string, unknown>;
};

export function resolveConfigAgents(config: Record<string, unknown> | null): ConfigAgentOption[] {
  const agentsNode = isRecord(config?.agents) ? config.agents : null;
  const entries = isRecord(agentsNode?.entries) ? agentsNode.entries : {};
  const agents: ConfigAgentOption[] = [];

  for (const [id, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = normalizeOptionalString(entry.name);
    const isDefault = entry.default === true;
    agents.push({ id, name, isDefault, record: entry });
  }

  return agents;
}

export function resolveNodeTargets(
  nodes: Array<Record<string, unknown>>,
  requiredCommands: string[],
): NodeTargetOption[] {
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const advertised = new Set(commands.map(String));
    const supports = requiredCommands.every((command) => advertised.has(command));
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
  modelIdentifier?: string;
};

const WATCH_PLATFORM_PATTERN = /\bwatchos\b/;
const TABLET_PLATFORM_PATTERN = /\b(ipados|ipad)\b/;
const PHONE_PLATFORM_PATTERN = /\b(ios|android|iphone)\b/;
const PHONE_CLIENT_IDS: ReadonlySet<string> = new Set([
  GATEWAY_CLIENT_IDS.IOS_APP,
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

/** Prefer client identity for browser/terminal sessions, then the machine's form factor. */
export function deviceIcon(source: DeviceIconSource): TemplateResult {
  const platform = source.platform?.trim().toLowerCase() ?? "";
  const model = source.modelIdentifier?.trim() ?? "";
  const clientId = source.clientId?.trim().toLowerCase() ?? "";
  const mode = source.clientMode?.trim().toLowerCase() ?? "";
  // Watch and tablet checks run before the phone check: watchOS/iPadOS
  // platforms would otherwise never match once "ios" is tested.
  if (
    model.startsWith("Watch") ||
    WATCH_PLATFORM_PATTERN.test(platform) ||
    clientId === GATEWAY_CLIENT_IDS.WATCHOS_APP
  ) {
    return deviceIcons.watch;
  }
  if (model.startsWith("iPad") || TABLET_PLATFORM_PATTERN.test(platform)) {
    return deviceIcons.tablet;
  }
  if (
    model.startsWith("iPhone") ||
    PHONE_PLATFORM_PATTERN.test(platform) ||
    PHONE_CLIENT_IDS.has(clientId)
  ) {
    return deviceIcons.smartphone;
  }
  if (BROWSER_CLIENT_IDS.has(clientId) || mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return deviceIcons.browser;
  }
  if (TERMINAL_CLIENT_MODES.has(mode) || TERMINAL_CLIENT_IDS.has(clientId)) {
    return deviceIcons.terminal;
  }
  if (mode === "gateway") {
    return deviceIcons.server;
  }
  switch (resolveMacFormFactor(model)) {
    case "laptop":
      return deviceIcons.laptop;
    case "mini":
      return deviceIcons.macMini;
    case "studio":
    case "pro":
      return deviceIcons.pcCase;
    case "imac":
      return deviceIcons.allInOne;
    default:
      return icons.monitor;
  }
}

/* Connectivity state lives in the row's renderSettingsStatus dot + text, so
   the tile stays a purely decorative form-factor glyph. */
export function renderDeviceTile(icon: TemplateResult) {
  return html`
    <div class="device-entry__tile" aria-hidden="true">
      <span class="device-entry__tile-icon">${icon}</span>
    </div>
  `;
}
