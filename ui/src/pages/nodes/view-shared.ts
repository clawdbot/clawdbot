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

// Form-factor glyphs used only by the device inventory; kept local because the
// shared icons registry is LOC-frozen for new entries.
const tabletIcon = html`
  <svg viewBox="0 0 24 24">
    <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </svg>
`;
const watchIcon = html`
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="6" />
    <polyline points="12 10 12 12 13 13" />
    <path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05" />
    <path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05" />
  </svg>
`;

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

/** Rough form-factor icon: watch, tablet, phone, browser, terminal, or desktop machine. */
export function deviceIcon(source: DeviceIconSource): TemplateResult {
  const platform = source.platform?.trim().toLowerCase() ?? "";
  const clientId = source.clientId?.trim().toLowerCase() ?? "";
  const mode = source.clientMode?.trim().toLowerCase() ?? "";
  // Watch and tablet checks run before the phone check: watchOS/iPadOS
  // platforms would otherwise never match once "ios" is tested.
  if (WATCH_PLATFORM_PATTERN.test(platform) || clientId === GATEWAY_CLIENT_IDS.WATCHOS_APP) {
    return watchIcon;
  }
  if (TABLET_PLATFORM_PATTERN.test(platform)) {
    return tabletIcon;
  }
  if (PHONE_PLATFORM_PATTERN.test(platform) || PHONE_CLIENT_IDS.has(clientId)) {
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
