import fs from "node:fs/promises";
import path from "node:path";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveLaunchAgentPlistPath } from "./launchd.js";
import { isBunRuntime, isNodeRuntime } from "./runtime-binary.js";
import {
  isSystemNodePath,
  isVersionManagedNodePath,
  resolveSystemNodePath,
} from "./runtime-paths.js";
import { getMinimalServicePathPartsFromEnv } from "./service-env.js";
import { SERVICE_PROXY_ENV_KEYS } from "./service-env.js";
import {
  collectInlineManagedServiceEnvKeys,
  hasInlineEnvironmentSource,
  isEnvironmentFileOnlySource,
} from "./service-managed-env.js";
import { isNonMinimalServicePathEntry, normalizeServicePathEntry } from "./service-path-policy.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
import { resolveSystemdUserUnitPath } from "./systemd.js";

export type GatewayServiceCommand = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
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
  gatewayTokenEmbedded: "gateway-token-embedded",
  gatewayManagedEnvEmbedded: "gateway-managed-env-embedded",
  gatewayPortMismatch: "gateway-port-mismatch",
  gatewayProxyEnvEmbedded: "gateway-proxy-env-embedded",
  gatewayTokenMismatch: "gateway-token-mismatch",
  gatewayRuntimeBun: "gateway-runtime-bun",
  gatewayRuntimeNodeVersionManager: "gateway-runtime-node-version-manager",
  gatewayRuntimeNodeSystemMissing: "gateway-runtime-node-system-missing",
  gatewayTokenDrift: "gateway-token-drift",
  launchdKeepAlive: "launchd-keep-alive",
  launchdRunAtLoad: "launchd-run-at-load",
  systemdAfterNetworkOnline: "systemd-after-network-online",
  systemdRestartSec: "systemd-restart-sec",
  systemdWantsNetworkOnline: "systemd-wants-network-online",
} as const;

export function needsNodeRuntimeMigration(issues: ServiceConfigIssue[]): boolean {
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
    if (!line) {
      continue;
    }
    if (line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "After") {
      for (const entry of value.split(/\s+/)) {
        if (entry) {
          after.add(entry);
        }
      }
    } else if (key === "Wants") {
      for (const entry of value.split(/\s+/)) {
        if (entry) {
          wants.add(entry);
        }
      }
    } else if (key === "RestartSec") {
      restartSec = value;
    }
  }

  return { after, wants, restartSec };
}

function isRestartSecPreferred(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return false;
  }
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

function auditGatewayCommand(programArguments: string[] | undefined, issues: ServiceConfigIssue[]) {
  if (!programArguments || programArguments.length === 0) {
    return;
  }
  if (!hasGatewaySubcommand(programArguments)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayCommandMissing,
      message: "Service command does not include the gateway subcommand",
      level: "aggressive",
    });
  }
}

function parseGatewayPortArg(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

export function readGatewayServiceCommandPort(programArguments?: string[]): number | undefined {
  if (!programArguments || programArguments.length === 0) {
    return undefined;
  }
  for (let index = 0; index < programArguments.length; index += 1) {
    const arg = programArguments[index];
    if (arg === "--port") {
      return parseGatewayPortArg(programArguments[index + 1]);
    }
    if (arg.startsWith("--port=")) {
      return parseGatewayPortArg(arg.slice("--port=".length));
    }
  }
  return undefined;
}

function auditGatewayServicePort(params: {
  programArguments: string[] | undefined;
  issues: ServiceConfigIssue[];
  expectedPort?: number;
}) {
  if (
    typeof params.expectedPort !== "number" ||
    !Number.isSafeInteger(params.expectedPort) ||
    params.expectedPort <= 0 ||
    params.expectedPort > 65535
  ) {
    return;
  }
  const servicePort = readGatewayServiceCommandPort(params.programArguments);
  if (servicePort === undefined || servicePort === params.expectedPort) {
    return;
  }
  params.issues.push({
    code: SERVICE_AUDIT_CODES.gatewayPortMismatch,
    message: "Gateway service port does not match current gateway config.",
    detail: `${servicePort} -> ${params.expectedPort}`,
    level: "recommended",
  });
}

function auditGatewayToken(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  expectedGatewayToken?: string,
) {
  const serviceToken = readEmbeddedGatewayToken(command);
  if (!serviceToken) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayTokenEmbedded,
    message: "Gateway service embeds OPENCLAW_GATEWAY_TOKEN and should be reinstalled.",
    detail: "Run `openclaw gateway install --force` to remove embedded service token.",
    level: "recommended",
  });
  const expectedToken = normalizeOptionalString(expectedGatewayToken);
  if (!expectedToken || serviceToken === expectedToken) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayTokenMismatch,
    message:
      "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token in openclaw.json",
    detail: "service token is stale",
    level: "recommended",
  });
}

function auditManagedServiceEnvironment(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  expectedManagedServiceEnvKeys?: Iterable<string>,
) {
  const inlineKeys = collectInlineManagedServiceEnvKeys(command, expectedManagedServiceEnvKeys);
  if (inlineKeys.length === 0) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded,
    message: "Gateway service embeds managed environment values that should load at runtime.",
    detail: `inline keys: ${inlineKeys.join(", ")}`,
    level: "recommended",
  });
}

function normalizeServiceEnvKey(key: string): string | null {
  return normalizeEnvVarKey(key, { portable: true })?.toUpperCase() ?? null;
}

function readEnvironmentValueSource(
  command: GatewayServiceCommand,
  normalizedKey: string,
): GatewayServiceEnvironmentValueSource | undefined {
  for (const [rawKey, source] of Object.entries(command?.environmentValueSources ?? {})) {
    if (normalizeServiceEnvKey(rawKey) === normalizedKey) {
      return source;
    }
  }
  return undefined;
}

const SERVICE_PROXY_ENV_KEY_SET = new Set(
  SERVICE_PROXY_ENV_KEYS.flatMap((key) => {
    const normalized = normalizeServiceEnvKey(key);
    return normalized ? [normalized] : [];
  }),
);

function collectInlineProxyEnvKeys(command: GatewayServiceCommand): string[] {
  if (!command?.environment) {
    return [];
  }
  const inlineKeys: string[] = [];
  for (const [rawKey, value] of Object.entries(command.environment)) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const normalized = normalizeServiceEnvKey(rawKey);
    if (!normalized || !SERVICE_PROXY_ENV_KEY_SET.has(normalized)) {
      continue;
    }
    if (!hasInlineEnvironmentSource(readEnvironmentValueSource(command, normalized))) {
      continue;
    }
    inlineKeys.push(normalized);
  }
  return [...new Set(inlineKeys)].toSorted();
}

function auditProxyServiceEnvironment(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
) {
  const inlineKeys = collectInlineProxyEnvKeys(command);
  if (inlineKeys.length === 0) {
    return;
  }
  issues.push({
    code: SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    message: "Gateway service embeds proxy environment values that should not be persisted.",
    detail: `inline keys: ${inlineKeys.join(", ")}`,
    level: "recommended",
  });
}

export function readEmbeddedGatewayToken(command: GatewayServiceCommand): string | undefined {
  if (!command) {
    return undefined;
  }
  if (isEnvironmentFileOnlySource(command.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN)) {
    return undefined;
  }
  return normalizeOptionalString(command.environment?.OPENCLAW_GATEWAY_TOKEN);
}

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function getEquivalentMinimalPathEntries(
  entry: string,
  platform: NodeJS.Platform,
  normalizedExpected: Set<string>,
): string[] {
  if (platform !== "linux") {
    return [];
  }
  const equivalent = entry.endsWith("/aliases/default/bin")
    ? `${entry.slice(0, -"/aliases/default/bin".length)}/current/bin`
    : entry.endsWith("/current/bin")
      ? `${entry.slice(0, -"/current/bin".length)}/aliases/default/bin`
      : undefined;
  if (!equivalent) {
    return [];
  }
  const normalizedEquivalent = normalizeServicePathEntry(equivalent, platform);
  return normalizedExpected.has(normalizedEquivalent) ? [equivalent] : [];
}

function auditGatewayServicePath(
  command: GatewayServiceCommand,
  issues: ServiceConfigIssue[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
) {
  if (platform === "win32") {
    return;
  }
  const servicePath = command?.environment?.PATH;
  if (!servicePath) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissing,
      message: "Gateway service PATH is not set; the daemon should use a minimal PATH.",
      level: "recommended",
    });
    return;
  }

  const expected = getMinimalServicePathPartsFromEnv({
    platform,
    env,
    includeMissingUserBinDefaults: false,
  });
  const parts = servicePath
    .split(getPathModule(platform).delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const normalizedParts = new Set(parts.map((entry) => normalizeServicePathEntry(entry, platform)));
  const normalizedExpected = new Set(
    expected.map((entry) => normalizeServicePathEntry(entry, platform)),
  );
  const missing = expected.filter((entry) => {
    const normalized = normalizeServicePathEntry(entry, platform);
    if (normalizedParts.has(normalized)) {
      return false;
    }
    return !getEquivalentMinimalPathEntries(entry, platform, normalizedExpected).some(
      (equivalent) => normalizedParts.has(normalizeServicePathEntry(equivalent, platform)),
    );
  });
  if (missing.length > 0) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
      message: `Gateway service PATH missing required dirs: ${missing.join(", ")}`,
      level: "recommended",
    });
  }

  const nonMinimal = parts.filter((entry) => {
    const normalized = normalizeServicePathEntry(entry, platform);
    if (normalizedExpected.has(normalized)) {
      return false;
    }
    return isNonMinimalServicePathEntry(normalized, platform);
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
  if (!execPath) {
    return;
  }

  if (isBunRuntime(execPath)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayRuntimeBun,
      message: "Gateway service uses Bun; Bun is incompatible with WhatsApp + Telegram channels.",
      detail: execPath,
      level: "recommended",
    });
    return;
  }

  if (!isNodeRuntime(execPath)) {
    return;
  }

  if (isVersionManagedNodePath(execPath, platform)) {
    issues.push({
      code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      message: "Gateway service uses Node from a version manager; it can break after upgrades.",
      detail: execPath,
      level: "recommended",
    });
    if (!isSystemNodePath(execPath, env, platform)) {
      const systemNode = await resolveSystemNodePath(env, platform);
      if (!systemNode) {
        issues.push({
          code: SERVICE_AUDIT_CODES.gatewayRuntimeNodeSystemMissing,
          message:
            "System Node 22 LTS (22.14+) or Node 24 not found; install it before migrating away from version managers.",
          level: "recommended",
        });
      }
    }
  }
}

/**
 * Check if the service's embedded token differs from the config file token.
 * Returns an issue if drift is detected (service will use old token after restart).
 */
export function checkTokenDrift(params: {
  serviceToken: string | undefined;
  configToken: string | undefined;
}): ServiceConfigIssue | null {
  const serviceToken = normalizeOptionalString(params.serviceToken);
  const configToken = normalizeOptionalString(params.configToken);

  // Tokenless service units are canonical; no drift to report.
  if (!serviceToken) {
    return null;
  }

  if (configToken && serviceToken !== configToken) {
    return {
      code: SERVICE_AUDIT_CODES.gatewayTokenDrift,
      message:
        "Config token differs from service token. The daemon will use the old token after restart.",
      detail: "Run `openclaw gateway install --force` to sync the token.",
      level: "recommended",
    };
  }

  return null;
}

export async function auditGatewayServiceConfig(params: {
  env: Record<string, string | undefined>;
  command: GatewayServiceCommand;
  platform?: NodeJS.Platform;
  expectedGatewayToken?: string;
  expectedManagedServiceEnvKeys?: Iterable<string>;
  expectedPort?: number;
}): Promise<ServiceConfigAudit> {
  const issues: ServiceConfigIssue[] = [];
  const platform = params.platform ?? process.platform;

  auditGatewayCommand(params.command?.programArguments, issues);
  auditGatewayServicePort({
    programArguments: params.command?.programArguments,
    issues,
    expectedPort: params.expectedPort,
  });
  auditManagedServiceEnvironment(params.command, issues, params.expectedManagedServiceEnvKeys);
  auditProxyServiceEnvironment(params.command, issues);
  auditGatewayToken(params.command, issues, params.expectedGatewayToken);
  auditGatewayServicePath(params.command, issues, params.env, platform);
  await auditGatewayRuntime(params.env, params.command, issues, platform);

  if (platform === "linux") {
    await auditSystemdUnit(params.env, issues);
  } else if (platform === "darwin") {
    await auditLaunchdPlist(params.env, issues);
  }

  return { ok: issues.length === 0, issues };
}
