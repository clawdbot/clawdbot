import fs from "node:fs/promises";
import path from "node:path";
import { resolveLaunchAgentPlistPath } from "./launchd.js";
import {
  isSystemNodePath,
  isVersionManagedNodePath,
  resolveSystemNodePath,
} from "./runtime-paths.js";
import { getMinimalServicePathParts } from "./service-env.js";
import { resolveSystemdUserUnitPath } from "./systemd.js";

export type GatewayServiceCommand = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null;

export type ServiceConfigIssue = {
  code: string;
  message: string;
  detail?: string;
  level?: "recommended" | "aggressive";
};

export type ServiceConfigAudit = {
  ok: boolean;
  issues: ServiceConfigIssue[];
};

export const SERVICE_AUDIT_CODES = {
  gatewayCommandMissing: "gateway-command-missing",
  gatewayEntrypointMismatch: "gateway-entrypoint-mismatch",
  gatewayPathMissing: "gateway-path-missing",
  gatewayPathMissingDirs: "gateway-path-missing-dirs",
  gatewayPathNonMinimal: "gateway-path-nonminimal",
  gatewayRuntimeBun: "gateway-runtime-bun",
  gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager",
  gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing",
  launchdKeepAlive: "launchd-keep-alive",
  launchdRunAtLoad: "launchd-run-at-load",
  systemdAfterNetworkOnline: "systemd-after-network-online",
  systemdRestartSec: "systemd-restart-sec",
  systemdWantsNetworkOnline: "systemd-wants-network-online",
} as const;

export function needsNodeRuntimeMigration(
  issues: ServiceConfigIssue[],
): boolean {
  return issues.some(
    (issue) =>
      issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun ||
      issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
  );
}

function hasGatewaySubcommand(programArguments?: string[]): boolean {
  return Boolean(programArguments?.some((arg) => arg === "gateway"));
}

function parseSystemdUnit(content: string): {
  after: Set<string>;
  wants: Set<string>;
  restartSec?: string;
} {
  const after = new Set<string>();
  const wants = new Set<string>();
  let restartSec: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "After") {
      for (const entry of value.split(/\s+/)) {
        if (entry) after.add(entry);
      }
    } else if (key === "Wants") {
      for (const entry of value.split(/\s+/)) {
        if (entry) wants.add(entry);
      }
    } else if (key === "RestartSec") {
      restartSec = value;
    }
  }

  return { after, wants, restartSec };
}

function isRestartSecPreferred(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(parsed - 5) < 0.01;
}

async function auditSystemdUnit(
  env: Record<string, string | undefined>,
  issues: ServiceConfigIssue[],
) {
  const unitPath = resolveSystemdUserUnitPath(env);
  let content = "";
  try {
    content = await fs.readFile(unitPath, "utf8");
  } catch {
    return;
  }

  const parsed = parseSystemdUnit(content);
  if (!parsed.after.has("network-online.target")) {
    issues.push({
      code: SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
      message: "Missing systemd After=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (!parsed.wants.has("network-online.target")) {
    issues.push({
      code: SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
      message: "Missing systemd Wants=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (!isRestartSecPreferred(parsed.restartSec)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.systemdRestartSec,
      message: "RestartSec does not match the recommended 5s",
      detail: unitPath,
      level: "recommended",
    });
  }
}

async function auditLaunchdPlist(
  env: Record<string, string | undefined>,
  issues: ServiceConfigIssue[],
) {
  const plistPath = resolveLaunchAgentPlistPath(env);
  let content = "";
  try {
    content = await fs.readFile(plistPath, "utf8");
  } catch {
    return;
  }

  const hasRunAtLoad = /<key>RunAtLoad<\/key>\s*<true\s*\/>/i.test(content);
  const hasKeepAlive = /<key>KeepAlive<\/key>\s*<true\s*\/>/i.test(content);
  if (!hasRunAtLoad) {
    issues.push({
      code: SERVICE_AUDIT_CODES.launchdRunAtLoad,
      message: "LaunchAgent is missing RunAtLoad=true",
      detail: plistPath,
      level: "recommended",
    });
  }
  if (!hasKeepAlive) {
    issues.push({
      code: SERVICE_AUDIT_CODES.launchdKeepAlive,
      message: "LaunchAgent is missing KeepAlive=true",
      detail: plistPath,
      level: "recommended",
    });
  }
}

function auditGatewayCommand(
  programArguments: string[] | undefined,
  issues: ServiceConfigIssue[],
) {
  if (!programArguments || programArguments.length === 0) return;
  if (!hasGatewaySubcommand(programArguments)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayCommandMissing,
      message: "Service command does not include the gateway subcommand",
      level: "aggressive",
    });
  }
}

function isNodeRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "node" || base === "node.exe";
}

function isBunRuntime(execPath: string): boolean {
  const base = path.basename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(entry).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function auditGatewayServicePath(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  platform: NodeJS.Platform,
) {
  if (platform === "win32") return;
  const servicePath = command?.environment?.PATH;
  if (!servicePath) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissing,
      message:
        "Gateway service PATH is not set; the daemon should use a minimal PATH.",
      level: "recommended",
    });
    return;
  }

  const expected = getMinimalServicePathParts({ platform });
  const parts = servicePath
    .split(getPathModule(platform).delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedParts = parts.map((entry) =>
    normalizePathEntry(entry, platform),
  );
  const missing = expected.filter((entry) => {
    const normalized = normalizePathEntry(entry, platform);
    return !normalizedParts.includes(normalized);
  });
  if (missing.length > 0) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
      message: `Gateway service PATH missing required dirs: ${missing.join(", ")}`,
      level: "recommended",
    });
  }

  const nonMinimal = parts.filter((entry) => {
    const normalized = normalizePathEntry(entry, platform);
    return (
      normalized.includes("/.nvm/") ||
      normalized.includes("/.fnm/") ||
      normalized.includes("/.volta/") ||
      normalized.includes("/.asdf/") ||
      normalized.includes("/.n/") ||
      normalized.includes("/.nodenv/") ||
      normalized.includes("/.nodebrew/") ||
      normalized.includes("/nvs/") ||
      normalized.includes("/.local/share/pnpm/") ||
      normalized.includes("/pnpm/") ||
      normalized.endsWith("/pnpm")
    );
  });
  if (nonMinimal.length > 0) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
      message:
        "Gateway service PATH includes version managers or package managers; recommend a minimal PATH.",
      detail: nonMinimal.join(", "),
      level: "recommended",
    });
  }
}

async function auditGatewayRuntime(
  env: Record<string, string | undefined>,
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  platform: NodeJS.Platform,
) {
  const execPath = command?.programArguments?.[0];
  if (!execPath) return;

  if (isBunRuntime(execPath)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayRuntimeBun,
      message:
        "Gateway service uses Bun; Bun is incompatible with WhatsApp + Telegram providers.",
      detail: execPath,
      level: "recommended",
    });
    return;
  }

  if (!isNodeRuntime(execPath)) return;

  if (isVersionManagedNodePath(execPath, platform)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      message:
        "Gateway service uses Node from a version manager; it can break after upgrades.",
      detail: execPath,
      level: "recommended",
    });
    if (!isSystemNodePath(execPath, env, platform)) {
      const systemNode = await resolveSystemNodePath(env, platform);
      if (!systemNode) {
        issues.push({
          code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
          message:
            "System Node 22+ not found; install it before migrating away from version managers.",
          level: "recommended",
        });
      }
    }
  }
}

export async function auditGatewayServiceConfig(params: {
  env: Record<string, string | undefined>;
  command: GatewayServiceCommand;
  platform?: NodeJS.Platform;
}): Promise<ServiceConfigAudit> {
  const issues: ServiceConfigIssue[] = [];
  const platform = params.platform ?? process.platform;

  auditGatewayCommand(params.command?.programArguments, issues);
  auditGatewayServicePath(params.command, issues, platform);
  await auditGatewayRuntime(params.env, params.command, issues, platform);

  if (platform === "linux") {
    await auditSystemdUnit(params.env, issues);
  } else if (platform === "darwin") {
    await auditLaunchdPlist(params.env, issues);
  }

  return { ok: issues.length === 0, issues };
}
