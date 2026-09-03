import { expectDefined } from "@openclaw/normalization-core";
// Gateway node command policy.
// Computes per-platform allowlists from built-in, plugin, runtime, and config inputs.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_BROWSER_PROXY_COMMANDS,
  NODE_DEVICE_APPS_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FILE_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_WORKER_PRIVATE_COMMANDS,
  isPrivateNodeInvokeCommand,
} from "../infra/node-commands.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime-state.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import { MOBILE_NODE_COMMANDS } from "./node-command-policy-mobile.js";

const CAMERA_COMMANDS = ["camera.list"];
const MAC_CAMERA_COMMANDS = ["camera.ptz.status"];

const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip", "camera.ptz.control"];

const SCREEN_COMMANDS = ["screen.snapshot"];
const SCREEN_DANGEROUS_COMMANDS = ["screen.record", NODE_DESKTOP_STREAM_COMMAND];

// Desktop computer use is advertised only while the node-local control is
// enabled. Pairing approval of that advertised surface is the durable grant.
const COMPUTER_COMMANDS = ["computer.act"];

// Android advertises these only while Accessibility Control is enabled. The
// action tool adds its own model-visible confirmation contract for mutations.
const MOBILE_UI_COMMANDS = ["mobile.ui.observe", "mobile.ui.act"];

const ANDROID_DEVICE_COMMANDS = [
  ...MOBILE_NODE_COMMANDS.device,
  "device.permissions",
  "device.health",
  NODE_DEVICE_APPS_COMMAND,
];

const CONTACTS_COMMANDS = ["contacts.search"];
const CONTACTS_DANGEROUS_COMMANDS = ["contacts.add"];

const CALENDAR_COMMANDS = ["calendar.events"];
const CALENDAR_DANGEROUS_COMMANDS = ["calendar.add"];

const CALL_LOG_COMMANDS = ["callLog.search"];

const REMINDERS_COMMANDS = ["reminders.list"];
const REMINDERS_DANGEROUS_COMMANDS = ["reminders.add"];

const PHOTOS_COMMANDS = ["photos.latest"];

const MOTION_COMMANDS = ["motion.activity", "motion.pedometer"];

const HEALTH_DANGEROUS_COMMANDS = ["health.summary"];

const SMS_DANGEROUS_COMMANDS = ["sms.send", "sms.search"];

export const TALK_PTT_COMMANDS = [
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
];

// The iPhone node owns the relay to its companion Watch. Keep these commands
// out of the direct watchOS node surface, which has a separate fixed policy.
export const IOS_WATCH_RELAY_COMMANDS = ["watch.status", "watch.notify"];

// iOS nodes don't implement system.run/which, but they do support notifications.
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];

const SYSTEM_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  ...NODE_FILE_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
];
const DESKTOP_HOST_COMMANDS = new Set<string>([
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  ...NODE_FILE_COMMANDS,
  ...NODE_BROWSER_PROXY_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  ...SCREEN_COMMANDS,
  NODE_DESKTOP_STREAM_COMMAND,
]);
const UNKNOWN_PLATFORM_COMMANDS = [
  ...CAMERA_COMMANDS,
  ...MOBILE_NODE_COMMANDS.location,
  NODE_SYSTEM_NOTIFY_COMMAND,
];

// "High risk" node commands. These can be enabled by explicitly adding them to
// `gateway.nodes.commands.allow` (and ensuring they're not blocked by commands.deny).
export const DEFAULT_DANGEROUS_NODE_COMMANDS = [
  ...CAMERA_DANGEROUS_COMMANDS,
  ...SCREEN_DANGEROUS_COMMANDS,
  ...CONTACTS_DANGEROUS_COMMANDS,
  ...CALENDAR_DANGEROUS_COMMANDS,
  ...REMINDERS_DANGEROUS_COMMANDS,
  ...SMS_DANGEROUS_COMMANDS,
  ...HEALTH_DANGEROUS_COMMANDS,
];

export const PLATFORM_DEFAULTS: Record<string, string[]> = {
  ios: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...IOS_SYSTEM_COMMANDS,
  ],
  watchos: [...MOBILE_NODE_COMMANDS.device, ...IOS_SYSTEM_COMMANDS],
  android: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.androidNotification,
    NODE_SYSTEM_NOTIFY_COMMAND,
    ...ANDROID_DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...CALL_LOG_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...MOBILE_UI_COMMANDS,
  ],
  macos: [
    ...CAMERA_COMMANDS,
    ...MAC_CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    NODE_DEVICE_APPS_COMMAND,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...SYSTEM_COMMANDS,
    ...SCREEN_COMMANDS,
    ...COMPUTER_COMMANDS,
  ],
  linux: [...SYSTEM_COMMANDS, ...SCREEN_COMMANDS, ...COMPUTER_COMMANDS],
  windows: [
    ...CAMERA_COMMANDS,
    ...MOBILE_NODE_COMMANDS.location,
    ...MOBILE_NODE_COMMANDS.device,
    ...SYSTEM_COMMANDS,
    ...SCREEN_COMMANDS,
    ...COMPUTER_COMMANDS,
  ],
  // Fail-safe: unknown metadata should not receive host exec defaults.
  unknown: [...UNKNOWN_PLATFORM_COMMANDS],
};
type PlatformId = "ios" | "watchos" | "android" | "macos" | "windows" | "linux" | "unknown";

const CANONICAL_PLATFORM_IDS = new Set<Exclude<PlatformId, "unknown">>([
  "ios",
  "watchos",
  "android",
  "macos",
  "windows",
  "linux",
]);

const DEVICE_FAMILY_TOKEN_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  tokens: readonly string[];
}> = [
  { id: "ios", tokens: ["iphone", "ipad", "ios"] },
  { id: "watchos", tokens: ["apple watch", "watchos"] },
  { id: "android", tokens: ["android"] },
  { id: "macos", tokens: ["mac"] },
  { id: "windows", tokens: ["windows"] },
  { id: "linux", tokens: ["linux"] },
] as const;

function resolvePlatformIdByExactMatch(value: string): Exclude<PlatformId, "unknown"> | undefined {
  if (CANONICAL_PLATFORM_IDS.has(value as Exclude<PlatformId, "unknown">)) {
    return value as Exclude<PlatformId, "unknown">;
  }
  return undefined;
}

function platformMatchesDeviceFamily(
  platformId: Exclude<PlatformId, "unknown">,
  family: string,
): boolean {
  switch (platformId) {
    case "ios":
      return family === "" || /^(?:iphone|ipad|ios)$/.test(family);
    case "watchos":
      return family === "apple watch" || family === "watchos";
    case "android":
      return family === "" || family === "android";
    case "macos":
      return family === "mac";
    case "windows":
      return family === "windows";
    case "linux":
      return family === "linux";
  }
  return false;
}

function resolvePlatformIdByNativeLabel(
  platform: string,
  deviceFamily: string,
): Exclude<PlatformId, "unknown"> | undefined {
  if (/^(?:ios|ipados) \d+(?:\.\d+){0,2}$/.test(platform)) {
    return /^(?:iphone|ipad|ios)$/.test(deviceFamily) ? "ios" : undefined;
  }
  if (/^watchos \d+(?:\.\d+){0,2}$/.test(platform)) {
    return /^(?:apple watch|watchos)$/.test(deviceFamily) ? "watchos" : undefined;
  }
  if (/^macos \d+(?:\.\d+){0,2}$/.test(platform)) {
    return deviceFamily === "mac" ? "macos" : undefined;
  }
  if (/^android \d+(?: \(sdk \d+\))?$/.test(platform)) {
    return deviceFamily === "android" ? "android" : undefined;
  }
  return undefined;
}

function resolvePlatformIdByDeviceFamily(
  value: string,
): Exclude<PlatformId, "unknown"> | undefined {
  for (const rule of DEVICE_FAMILY_TOKEN_RULES) {
    if (rule.tokens.some((token) => value.includes(token))) {
      return rule.id;
    }
  }
  return undefined;
}

function normalizePlatformId(platform?: string, deviceFamily?: string): PlatformId {
  const raw = normalizeDeviceMetadataForPolicy(platform);
  const family = normalizeDeviceMetadataForPolicy(deviceFamily);
  const byPlatform = resolvePlatformIdByExactMatch(raw);
  if (byPlatform) {
    return platformMatchesDeviceFamily(byPlatform, family) ? byPlatform : "unknown";
  }
  const byNativeLabel = resolvePlatformIdByNativeLabel(raw, family);
  if (byNativeLabel) {
    return byNativeLabel;
  }
  if (raw) {
    return "unknown";
  }
  const byFamily = resolvePlatformIdByDeviceFamily(family);
  return byFamily ?? "unknown";
}

export function listDangerousPluginNodeCommands(): string[] {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return [];
  }
  const commands = [
    ...registry.nodeHostCommands
      .filter((entry) => entry.command.dangerous === true)
      .map((entry) => entry.command.command),
    ...registry.nodeInvokePolicies
      .filter((entry) => entry.policy.dangerous === true)
      .flatMap((entry) => entry.policy.commands),
  ];
  return normalizeUniqueStringEntries(commands);
}

function listDefaultPluginNodeCommands(platformId: PlatformId): string[] {
  // The direct watch transport has a fixed, minimal command surface. Do not let
  // generic plugin defaults silently expand it when plugins are installed.
  if (platformId === "watchos") {
    return [];
  }
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return [];
  }
  const policyCommands = registry.nodeInvokePolicies.flatMap((entry) => {
    if (entry.policy.dangerous === true) {
      return [];
    }
    const defaults = entry.policy.defaultPlatforms ?? [];
    return defaults.includes(platformId) ? entry.policy.commands : [];
  });
  const nodeHostCommands = registry.nodeHostCommands
    .filter((entry) => {
      if (entry.command.dangerous === true) {
        return false;
      }
      const defaults = entry.command.agentTool?.defaultPlatforms ?? [];
      return defaults.includes(platformId);
    })
    .map((entry) => entry.command.command);
  return normalizeUniqueStringEntries([...policyCommands, ...nodeHostCommands]);
}

export function isForegroundRestrictedPluginNodeCommand(command: string): boolean {
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return false;
  }
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return registry.nodeInvokePolicies.some(
    (entry) =>
      entry.policy.foregroundRestrictedOnIos === true &&
      entry.policy.commands.some((policyCommand) => policyCommand.trim() === normalized),
  );
}
type NodeCommandPolicyNode = {
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  connId?: string;
  nodeId?: string;
  approvedCommands?: readonly string[];
};

function isDesktopPlatformId(platformId: PlatformId): boolean {
  return platformId === "macos" || platformId === "windows" || platformId === "linux";
}

function filterDesktopHostCommandDefaults(params: {
  platformId: PlatformId;
  commands: readonly string[];
  includeDesktopHostCommands?: boolean;
}): string[] {
  if (params.includeDesktopHostCommands === true || !isDesktopPlatformId(params.platformId)) {
    return [...params.commands];
  }
  return params.commands.filter((command) => !DESKTOP_HOST_COMMANDS.has(command));
}

function filterApprovedRuntimeCommands(params: {
  platformId: PlatformId;
  commands: readonly string[];
}): string[] {
  if (!isDesktopPlatformId(params.platformId)) {
    return [];
  }
  // Desktop host commands are not default-enabled for normal node sessions.
  // A live node can still expose approved commands from its runtime handshake.
  return params.commands.filter((command) => DESKTOP_HOST_COMMANDS.has(command.trim()));
}

function isLiveNodeSession(node: NodeCommandPolicyNode | undefined): boolean {
  return (
    typeof node?.nodeId === "string" &&
    node.nodeId.trim() !== "" &&
    typeof node.connId === "string" &&
    node.connId.trim() !== ""
  );
}

function hasTalkSurface(node?: NodeCommandPolicyNode): boolean {
  if (!node) {
    return false;
  }
  return (
    (node.caps ?? []).some(
      (capability) => normalizeOptionalLowercaseString(capability) === "talk",
    ) ||
    (node.commands ?? []).some((command) =>
      normalizeOptionalLowercaseString(command)?.startsWith("talk."),
    )
  );
}

function resolveNodeCommandAllowlistInternal(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
  options?: { includeDesktopHostCommands?: boolean; includeDangerousDefaults?: boolean },
): Set<string> {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
  const base = filterDesktopHostCommandDefaults({
    platformId,
    commands:
      expectDefined(PLATFORM_DEFAULTS[platformId], "platform defaults entry at platform id") ??
      PLATFORM_DEFAULTS.unknown,
    includeDesktopHostCommands: options?.includeDesktopHostCommands,
  });
  const watchRelayCommands =
    platformId === "ios" && normalizeDeviceMetadataForPolicy(node?.deviceFamily) === "iphone"
      ? IOS_WATCH_RELAY_COMMANDS
      : [];
  const talkCommands = hasTalkSurface(node) ? TALK_PTT_COMMANDS : [];
  const pluginDefaults = listDefaultPluginNodeCommands(platformId);
  const approved = filterApprovedRuntimeCommands({
    platformId,
    commands: node?.approvedCommands ?? (isLiveNodeSession(node) ? (node?.commands ?? []) : []),
  });
  const extra = cfg.gateway?.nodes?.commands?.allow ?? [];
  const deny = new Set(cfg.gateway?.nodes?.commands?.deny ?? []);
  // A plugin `dangerous` flag governs the surface that plugin contributes
  // (listDefaultPluginNodeCommands) and forces a registered invoke policy. It is
  // not authority to revoke a command core itself declares in PLATFORM_DEFAULTS,
  // whose grant chain is node-local enablement plus pairing approval. Letting it
  // do so disabled desktop `computer.act` on every Gateway that auto-starts a
  // bundled computer-use provider plugin.
  const baseCommands = new Set(base);
  const dangerousPluginCommands = new Set(
    listDangerousPluginNodeCommands().filter((command) => !baseCommands.has(command)),
  );
  // Dangerous built-ins that also appear in PLATFORM_DEFAULTS stay declarable
  // at pairing but do not enter the runtime allowlist by default.
  const dangerousBuiltinCommands =
    options?.includeDangerousDefaults === true
      ? new Set<string>()
      : new Set(DEFAULT_DANGEROUS_NODE_COMMANDS);
  // Dangerous plugin commands are excluded from plugin defaults. Explicit
  // gateway.nodes.commands.allow below can still opt them in for operators.
  const allow = new Set(
    [...base, ...watchRelayCommands, ...talkCommands, ...pluginDefaults, ...approved, ...extra]
      .map((cmd) => cmd.trim())
      .filter(
        (cmd) => cmd && !dangerousPluginCommands.has(cmd) && !dangerousBuiltinCommands.has(cmd),
      ),
  );
  for (const cmd of extra) {
    const trimmed = cmd.trim();
    if (trimmed) {
      allow.add(trimmed);
    }
  }
  if (cfg.wizard?.appRecommendations === false) {
    allow.delete(NODE_DEVICE_APPS_COMMAND);
  }
  // In pairing mode, denylisted dangerous defaults stay declarable so an
  // explicit persistent allow can authorize them without another pairing.
  // Invoke-time policy still honors deny in full.
  const denyExemptDeclarable =
    options?.includeDangerousDefaults === true
      ? new Set(DEFAULT_DANGEROUS_NODE_COMMANDS)
      : new Set<string>();
  for (const blocked of deny) {
    const trimmed = blocked.trim();
    if (trimmed && !denyExemptDeclarable.has(trimmed)) {
      allow.delete(trimmed);
    }
  }
  for (const privateCommand of NODE_WORKER_PRIVATE_COMMANDS) {
    allow.delete(privateCommand);
  }
  return allow;
}

export function resolveNodeCommandAllowlist(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
): Set<string> {
  return resolveNodeCommandAllowlistInternal(cfg, node);
}

export function resolveNodePairingCommandAllowlist(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
): Set<string> {
  return resolveNodeCommandAllowlistInternal(cfg, node, {
    includeDesktopHostCommands: true,
    includeDangerousDefaults: true,
  });
}

function normalizeDeclaredCommands(commands?: readonly string[]): string[] {
  if (!Array.isArray(commands)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of commands) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed) || isPrivateNodeInvokeCommand(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeDeclaredNodeCommands(params: {
  declaredCommands?: readonly string[];
  allowlist: Set<string>;
}): string[] {
  return normalizeDeclaredCommands(params.declaredCommands).filter((command) =>
    params.allowlist.has(command),
  );
}

// Capability and command are one advertisement: a node offers `computer` because
// it can run `computer.act`. Keeping the capability after policy withheld every
// command that fulfills it yields a surface that reads as available and then
// rejects every invoke. Families core does not own here stay untouched.
const CAPABILITY_COMMAND_FAMILIES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["camera", new Set([...CAMERA_COMMANDS, ...MAC_CAMERA_COMMANDS, ...CAMERA_DANGEROUS_COMMANDS])],
  ["computer", new Set(COMPUTER_COMMANDS)],
  ["location", new Set(MOBILE_NODE_COMMANDS.location)],
  ["screen", new Set([...SCREEN_COMMANDS, ...SCREEN_DANGEROUS_COMMANDS])],
]);

/** Drops capabilities whose commands policy withheld without admitting a sibling. */
export function retainFulfilledNodeCapabilities(params: {
  caps: readonly string[];
  admittedCommands: readonly string[];
  withheldCommands: readonly string[];
}): string[] {
  return params.caps.filter((capability) => {
    const family = CAPABILITY_COMMAND_FAMILIES.get(capability);
    return (
      !family ||
      !params.withheldCommands.some((command) => family.has(command)) ||
      params.admittedCommands.some((command) => family.has(command))
    );
  });
}

export function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: readonly string[];
  allowlist: Set<string>;
}): { ok: true } | { ok: false; reason: string } {
  const command = params.command.trim();
  if (!command) {
    return { ok: false, reason: "command required" };
  }
  if (isPrivateNodeInvokeCommand(command)) {
    return { ok: false, reason: "command not allowlisted" };
  }
  if (!params.allowlist.has(command)) {
    return { ok: false, reason: "command not allowlisted" };
  }
  if (Array.isArray(params.declaredCommands) && params.declaredCommands.length > 0) {
    if (!params.declaredCommands.includes(command)) {
      return { ok: false, reason: "command not declared by node" };
    }
  } else {
    return { ok: false, reason: "node did not declare commands" };
  }
  return { ok: true };
}

export type RequiredNodeCommandAuthority = {
  command: string;
  state: "invocable" | "pending-approval" | "undeclared" | "unauthorized";
};

/**
 * Resolves declaration, pairing, and runtime policy once at their Gateway owner.
 * Clients receive one closed state instead of rebuilding authority from partial lists.
 */
export function resolveRequiredNodeCommandAuthority(params: {
  requiredCommands: readonly string[];
  declaredCommands: readonly string[];
  effectiveCommands: readonly string[];
  withheldCommands: readonly string[];
  allowlist: Set<string>;
}): RequiredNodeCommandAuthority | undefined {
  const declaredCommands = new Set(params.declaredCommands);
  const effectiveCommands = new Set(params.effectiveCommands);
  const withheldCommands = new Set(params.withheldCommands);
  for (const command of params.requiredCommands) {
    if (
      effectiveCommands.has(command) &&
      isNodeCommandAllowed({
        command,
        declaredCommands: params.effectiveCommands,
        allowlist: params.allowlist,
      }).ok
    ) {
      continue;
    }
    if (declaredCommands.has(command) && !effectiveCommands.has(command)) {
      return { command, state: "pending-approval" };
    }
    if (declaredCommands.has(command) || withheldCommands.has(command)) {
      return { command, state: "unauthorized" };
    }
    return { command, state: "undeclared" };
  }
  const command = params.requiredCommands[0];
  return command ? { command, state: "invocable" } : undefined;
}
