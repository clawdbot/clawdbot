// Gateway node command policy.
// Computes per-platform allowlists from built-in, plugin, runtime, and config inputs.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  NODE_BROWSER_PROXY_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../plugins/runtime.js";
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import type { NodeSession } from "./node-registry.js";

const CAMERA_COMMANDS = ["camera.list"];
const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip"];

const SCREEN_COMMANDS = ["screen.snapshot"];
const SCREEN_DANGEROUS_COMMANDS = ["screen.record"];

// Desktop computer use (pointer/keyboard injection). Declarable at pairing on
// macOS but invocable only with explicit allowCommands opt-in (arming).
const COMPUTER_DANGEROUS_COMMANDS = ["computer.act"];

const LOCATION_COMMANDS = ["location.get"];
const NOTIFICATION_COMMANDS = ["notifications.list"];
const ANDROID_NOTIFICATION_COMMANDS = [...NOTIFICATION_COMMANDS, "notifications.actions"];

const DEVICE_COMMANDS = ["device.info", "device.status"];
const ANDROID_DEVICE_COMMANDS = [
  ...DEVICE_COMMANDS,
  "device.permissions",
  "device.health",
  "device.apps",
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

const SMS_DANGEROUS_COMMANDS = ["sms.send", "sms.search"];

const TALK_PTT_COMMANDS = ["talk.ptt.start", "talk.ptt.stop", "talk.ptt.cancel", "talk.ptt.once"];

// iOS nodes don't implement system.run/which, but they do support notifications.
const IOS_SYSTEM_COMMANDS = [NODE_SYSTEM_NOTIFY_COMMAND];

const SYSTEM_COMMANDS = [
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_BROWSER_PROXY_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
];
const DESKTOP_HOST_COMMANDS = new Set<string>([
  ...NODE_SYSTEM_RUN_COMMANDS,
  ...NODE_EXEC_APPROVALS_COMMANDS,
  NODE_BROWSER_PROXY_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  ...SCREEN_COMMANDS,
]);
const UNKNOWN_PLATFORM_COMMANDS = [
  ...CAMERA_COMMANDS,
  ...LOCATION_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
];

// "High risk" node commands. These can be enabled by explicitly adding them to
// `gateway.nodes.allowCommands` (and ensuring they're not blocked by denyCommands).
export const DEFAULT_DANGEROUS_NODE_COMMANDS = [
  ...CAMERA_DANGEROUS_COMMANDS,
  ...SCREEN_DANGEROUS_COMMANDS,
  ...COMPUTER_DANGEROUS_COMMANDS,
  ...CONTACTS_DANGEROUS_COMMANDS,
  ...CALENDAR_DANGEROUS_COMMANDS,
  ...REMINDERS_DANGEROUS_COMMANDS,
  ...SMS_DANGEROUS_COMMANDS,
];

const PLATFORM_DEFAULTS: Record<string, string[]> = {
  ios: [
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...IOS_SYSTEM_COMMANDS,
  ],
  watchos: [...DEVICE_COMMANDS, ...IOS_SYSTEM_COMMANDS],
  android: [
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...ANDROID_NOTIFICATION_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
    ...ANDROID_DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...CALL_LOG_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
  ],
  macos: [
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...DEVICE_COMMANDS,
    ...CONTACTS_COMMANDS,
    ...CALENDAR_COMMANDS,
    ...REMINDERS_COMMANDS,
    ...PHOTOS_COMMANDS,
    ...MOTION_COMMANDS,
    ...SYSTEM_COMMANDS,
    ...SCREEN_COMMANDS,
    // Dangerous: declarable at pairing so the surface gets approved once, but
    // excluded from the runtime allowlist until explicitly armed (see
    // resolveNodeCommandAllowlistInternal).
    ...COMPUTER_DANGEROUS_COMMANDS,
  ],
  linux: [...SYSTEM_COMMANDS],
  windows: [
    ...CAMERA_COMMANDS,
    ...LOCATION_COMMANDS,
    ...DEVICE_COMMANDS,
    ...SYSTEM_COMMANDS,
    ...SCREEN_COMMANDS,
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

export function filterLegacyNodeProtocolFeatures(params: {
  caps: readonly string[];
  commands: readonly string[];
  pluginSurfaces: readonly string[];
}): { caps: string[]; commands: string[] } {
  // N-1 nodes predate plugin-hosted surfaces. Preserve their durable pairing
  // declarations elsewhere, but hide unusable plugin features from this session.
  const registry = getActivePluginGatewayNodePolicyRegistry();
  if (!registry) {
    return { caps: [...params.caps], commands: [...params.commands] };
  }
  const pluginIds = new Set([
    ...registry.nodeHostCommands.map((entry) => entry.pluginId),
    ...registry.nodeInvokePolicies.map((entry) => entry.pluginId),
  ]);
  const pluginCaps = new Set([...params.pluginSurfaces, ...pluginIds]);
  const pluginCommands = new Set([
    ...registry.nodeHostCommands.map((entry) => entry.command.command),
    ...registry.nodeInvokePolicies.flatMap((entry) => entry.policy.commands),
  ]);
  return {
    caps: params.caps.filter((cap) => !pluginCaps.has(cap)),
    commands: params.commands.filter((command) => !pluginCommands.has(command)),
  };
}

type NodeCommandPolicyNode = Pick<NodeSession, "platform" | "deviceFamily"> &
  Partial<Pick<NodeSession, "caps" | "commands" | "connId" | "nodeId">> & {
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
    commands: PLATFORM_DEFAULTS[platformId] ?? PLATFORM_DEFAULTS.unknown,
    includeDesktopHostCommands: options?.includeDesktopHostCommands,
  });
  const talkCommands = hasTalkSurface(node) ? TALK_PTT_COMMANDS : [];
  const pluginDefaults = listDefaultPluginNodeCommands(platformId);
  const approved = filterApprovedRuntimeCommands({
    platformId,
    commands: node?.approvedCommands ?? (isLiveNodeSession(node) ? (node?.commands ?? []) : []),
  });
  const extra = cfg.gateway?.nodes?.allowCommands ?? [];
  const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
  const dangerousPluginCommands = new Set(listDangerousPluginNodeCommands());
  // Dangerous built-ins in PLATFORM_DEFAULTS (e.g. computer.act on macOS) stay
  // declarable/approvable at pairing but never enter the runtime allowlist by
  // default; the pairing variant opts in via includeDangerousDefaults.
  const dangerousBuiltinCommands =
    options?.includeDangerousDefaults === true
      ? new Set<string>()
      : new Set(DEFAULT_DANGEROUS_NODE_COMMANDS);
  // Dangerous plugin commands are excluded from plugin defaults. Explicit
  // gateway.nodes.allowCommands below can still opt them in for operators.
  const allow = new Set(
    [...base, ...talkCommands, ...pluginDefaults, ...approved, ...extra]
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
  // In pairing mode, denylisted dangerous defaults stay declarable so a node
  // retains the surface it can later be armed for: arming removes them from
  // denyCommands and adds them to allowCommands. Fresh setup seeds denyCommands
  // with DEFAULT_DANGEROUS_NODE_COMMANDS, so without this exemption a declarable
  // dangerous default (e.g. computer.act on macOS) would be stripped from the
  // pairing surface and stay uninvocable even after arming, because the live
  // node session never retained the command. Invoke-time policy still gates
  // every call on the runtime allowlist, which honors deny in full.
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
    if (!trimmed || seen.has(trimmed)) {
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

export function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
}): { ok: true } | { ok: false; reason: string } {
  const command = params.command.trim();
  if (!command) {
    return { ok: false, reason: "command required" };
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
