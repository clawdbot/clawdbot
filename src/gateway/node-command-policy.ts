import type { MoltbotConfig } from "../config/config.js";
import type { NodeSession } from "./node-registry.js";

const CANVAS_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

const CAMERA_COMMANDS = ["camera.list", "camera.snap", "camera.clip"];

const SCREEN_COMMANDS = ["screen.record"];

const LOCATION_COMMANDS = ["location.get"];

const SMS_COMMANDS = ["sms.send"];

const SYSTEM_COMMANDS = [
  "system.run",
  "system.which",
  "system.notify",
  "system.execApprovals.get",
  "system.execApprovals.set",
  "browser.proxy",
];

const PLATFORM_DEFAULTS: Record<string, string[]> = {
  ios: [...CANVAS_COMMANDS, ...CAMERA_COMMANDS, ...SCREEN_COMMANDS, ...LOCATION_COMMANDS],
  android: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...SCREEN_COMMANDS,
    ...LOCATION_COMMANDS,
    ...SMS_COMMANDS,
  ],
  macos: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...SCREEN_COMMANDS,
    ...LOCATION_COMMANDS,
    ...SYSTEM_COMMANDS,
  ],
  linux: [...SYSTEM_COMMANDS],
  windows: [...SYSTEM_COMMANDS],
  unknown: [
    ...CANVAS_COMMANDS,
    ...CAMERA_COMMANDS,
    ...SCREEN_COMMANDS,
    ...LOCATION_COMMANDS,
    ...SMS_COMMANDS,
    ...SYSTEM_COMMANDS,
  ],
};

function normalizePlatformId(platform?: string, deviceFamily?: string): string {
  const raw = (platform ?? "").trim().toLowerCase();
  if (raw.startsWith("ios")) return "ios";
  if (raw.startsWith("android")) return "android";
  if (raw.startsWith("mac")) return "macos";
  if (raw.startsWith("darwin")) return "macos";
  if (raw.startsWith("win")) return "windows";
  if (raw.startsWith("linux")) return "linux";
  const family = (deviceFamily ?? "").trim().toLowerCase();
  if (family.includes("iphone") || family.includes("ipad") || family.includes("ios")) return "ios";
  if (family.includes("android")) return "android";
  if (family.includes("mac")) return "macos";
  if (family.includes("windows")) return "windows";
  if (family.includes("linux")) return "linux";
  return "unknown";
}

export function resolveNodeCommandAllowlist(
  cfg: MoltbotConfig,
  node?: Pick<NodeSession, "platform" | "deviceFamily">,
): Set<string> {
  const platformId = normalizePlatformId(node?.platform, node?.deviceFamily);
  const base = PLATFORM_DEFAULTS[platformId] ?? PLATFORM_DEFAULTS.unknown;
  const extra = cfg.gateway?.nodes?.allowCommands ?? [];
  const deny = new Set(cfg.gateway?.nodes?.denyCommands ?? []);
  const allow = new Set([...base, ...extra].map((cmd) => cmd.trim()).filter(Boolean));
  for (const blocked of deny) {
    const trimmed = blocked.trim();
    if (trimmed) allow.delete(trimmed);
  }
  return allow;
}

export function isNodeCommandAllowed(params: {
  command: string;
  declaredCommands?: string[];
  allowlist: Set<string>;
}): { ok: true } | { ok: false; reason: string } {
  const command = params.command.trim();
  if (!command) return { ok: false, reason: "command required" };
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
