import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  NODE_BROWSER_PROXY_COMMAND,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeDeviceMetadataForPolicy } from "./device-metadata-normalization.js";
import type { NodeSession } from "./node-registry.js";

const CAMERA_COMMANDS = ["camera.list"];
const CAMERA_DANGEROUS_COMMANDS = ["camera.snap", "camera.clip"];

const SCREEN_COMMANDS = ["screen.snapshot"];
const SCREEN_DANGEROUS_COMMANDS = ["screen.record"];

const LOCATION_COMMANDS = ["location.get"];
const NOTIFICATION_COMMANDS = ["notifications.list"];
const ANDROID_NOTIFICATION_COMMANDS = [...NOTIFICATION_COMMANDS, "notifications.actions"];

const DEVICE_COMMANDS = ["device.info", "device.status"];
const ANDROID_DEVICE_COMMANDS = [...DEVICE_COMMANDS, "device.permissions", "device.health"];

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
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_BROWSER_PROXY_COMMAND,
];
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

type PlatformId = "ios" | "android" | "macos" | "windows" | "linux" | "unknown";

const PLATFORM_PREFIX_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  prefixes: readonly string[];
}> = [
  { id: "ios", prefixes: ["ios"] },
  { id: "android", prefixes: ["android"] },
  { id: "macos", prefixes: ["mac", "darwin"] },
  { id: "windows", prefixes: ["win"] },
  { id: "linux", prefixes: ["linux"] },
] as const;

const DEVICE_FAMILY_TOKEN_RULES: ReadonlyArray<{
  id: Exclude<PlatformId, "unknown">;
  tokens: readonly string[];
}> = [
  { id: "ios", tokens: ["iphone", "ipad", "ios"] },
  { id: "android", tokens: ["android"] },
  { id: "macos", tokens: ["mac"] },
  { id: "windows", tokens: ["windows"] },
  { id: "linux", tokens: ["linux"] },
] as const;

function resolvePlatformIdByPrefix(value: string): Exclude<PlatformId, "unknown"> | undefined {
  for (const rule of PLATFORM_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => value.startsWith(prefix))) {
      return rule.id;
    }
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
  const byPlatform = resolvePlatformIdByPrefix(raw);
  if (byPlatform) {
    return byPlatform;
  }
  const family = normalizeDeviceMetadataForPolicy(deviceFamily);
  const byFamily = resolvePlatformIdByDeviceFamily(family);
  return byFamily ?? "unknown";
}

export function listDangerousPluginNodeCommands(): string[] {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    return [];
  }
  const commands = [
    ...(registry.nodeHostCommands ?? [])
      .filter((entry) => entry.command.dangerous === true)
      .map((entry) => entry.command.command),
    ...(registry.nodeInvokePolicies ?? [])
      .filter((entry) => entry.policy.dangerous === true)
      .flatMap((entry) => entry.policy.commands),
  ];
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

function listDefaultPluginNodeCommands(platformId: PlatformId): string[] {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    return [];
  }
  const commands = (registry.nodeInvokePolicies ?? []).flatMap((entry) => {
    if (entry.policy.dangerous === true) {
      return [];
    }
    const defaults = entry.policy.defaultPlatforms ?? [];
    return defaults.includes(platformId) ? entry.policy.commands : [];
  });
  return [...new Set(commands.map((command) => command.trim()).filter(Boolean))];
}

export function isForegroundRestrictedPluginNodeCommand(command: string): boolean {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    return false;
  }
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return (registry.nodeInvokePolicies ?? []).some(
    (entry) =>
      entry.policy.foregroundRestrictedOnIos === true &&
      entry.policy.commands.some((policyCommand) => policyCommand.trim() === normalized),
  );
}

type NodeCommandPolicyNode = Pick<NodeSession, "platform" | "deviceFamily"> &
  Partial<Pick<NodeSession, "caps" | "commands">>;

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

export function resolveNodeCommandAllowlist(
  cfg: OpenClawConfig,
  node?: NodeCommandPolicyNode,
): Set<string> {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
  const base = PLATFORM_DEFAULTS[platformId] ?? PLATFORM_DEFAULTS.unknown;
  const talkCommands = hasTalkSurface(node) ? TALK_PTT_COMMANDS : [];
  const pluginDefaults = listDefaultPluginNodeCommands(platformId);
  const extra = cfg.gateway?.nodes?.allowCommands ?? [];
  const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
  const dangerousPluginCommands = new Set(listDangerousPluginNodeCommands());
  const allow = new Set(
    [...base, ...talkCommands, ...pluginDefaults, ...extra]
      .map((cmd) => cmd.trim())
      .filter((cmd) => cmd && !dangerousPluginCommands.has(cmd)),
  );
  for (const cmd of extra) {
    const trimmed = cmd.trim();
    if (trimmed) {
      allow.add(trimmed);
    }
  }
  for (const blocked of deny) {
    const trimmed = blocked.trim();
    if (trimmed) {
      allow.delete(trimmed);
    }
  }
  return allow;
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
