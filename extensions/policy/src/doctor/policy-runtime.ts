import os from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import JSON5 from "json5";
import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PolicyAuthProfileEvidence } from "../policy-state.js";
import { POLICY_TOOL_GROUPS } from "../tool-policy-conformance.js";
import { CHECK_IDS } from "./check-ids.js";
import {
  SUPPORTED_AUTH_PROFILE_METADATA,
  SUPPORTED_AUTH_PROFILE_MODES,
} from "./policy-constants.js";
import { readPolicyStringArray } from "./utils.js";

const loadFsPromisesModule = createLazyRuntimeModule(() => import("node:fs/promises"));

export async function readPolicyFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const displayName = policyDisplayName(ctx);
  const path = resolveWorkspacePath(ctx, policyPathSetting(ctx));
  try {
    const fs = await loadFsPromisesModule();
    return {
      raw: await fs.readFile(path, "utf-8"),
      path,
      displayName,
      ocDocName: basename(displayName),
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

export async function readExecApprovalsFile(
  ctx: HealthCheckContext,
): Promise<{ raw: string; path: string; displayName: string; ocDocName: string } | null> {
  const artifact = execApprovalsArtifactLocation(ctx);
  try {
    const fs = await loadFsPromisesModule();
    return {
      raw: await fs.readFile(artifact.path, "utf-8"),
      path: artifact.path,
      displayName: artifact.displayName,
      ocDocName: "exec-approvals.json",
    };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

export async function readWorkspaceFile(
  ctx: HealthCheckContext,
  fileName: string,
): Promise<{ raw: string; path: string } | null> {
  const path = resolveWorkspacePath(ctx, fileName);
  try {
    const fs = await loadFsPromisesModule();
    return { raw: await fs.readFile(path, "utf-8"), path };
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

function resolvePolicyArtifactPath(ctx: HealthCheckContext, fileName: string): string {
  if (fileName.startsWith("~/") || fileName.startsWith("~\\")) {
    const home = resolvePolicyArtifactHomeDir();
    if (home !== undefined) {
      return resolve(home, fileName.slice(2));
    }
  }
  return resolveWorkspacePath(ctx, fileName);
}

function resolvePolicyArtifactHomeDir(): string | undefined {
  const explicitHome = normalizedEnvValue(process.env.OPENCLAW_HOME);
  if (explicitHome !== undefined) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      return resolvePolicyHomeRelativePath(explicitHome);
    }
    return resolve(explicitHome);
  }
  return resolveOsPolicyHomeDir();
}

function resolvePolicyHomeRelativePath(value: string): string {
  const fallbackHome = resolveOsPolicyHomeDir();
  return fallbackHome === undefined
    ? resolve(value)
    : resolve(value.replace(/^~(?=$|[\\/])/, fallbackHome));
}

function resolveOsPolicyHomeDir(): string | undefined {
  return (
    normalizedEnvValue(process.env.HOME) ??
    normalizedEnvValue(process.env.USERPROFILE) ??
    safeOsHomeDir()
  );
}

function safeOsHomeDir(): string | undefined {
  try {
    return normalizedEnvValue(os.homedir());
  } catch {
    return undefined;
  }
}

function normalizedEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "undefined" || trimmed === "null"
    ? undefined
    : trimmed;
}

function resolveWorkspacePath(ctx: HealthCheckContext, fileName: string): string {
  if (isAbsolute(fileName)) {
    return fileName;
  }
  return resolve(ctx.cwd ?? process.cwd(), fileName);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export function parseExecApprovalsFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    const value = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) {
      return { ok: false, message: "unsupported exec approvals version" };
    }
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function parsePolicyFile(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON5.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function workspaceRepairsEnabled(ctx: HealthCheckContext): boolean {
  return policySettings(ctx).workspaceRepairs === true;
}

export function workspaceRepairsDisabledResult(fileName: string): {
  readonly status: "skipped";
  readonly reason: string;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
} {
  const reason = "workspace repairs are disabled";
  return {
    status: "skipped",
    reason,
    changes: [],
    warnings: [
      `Skipped ${fileName} repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.`,
    ],
  };
}

export function readChannelDenyRules(
  policy: unknown,
  policyDocName: string,
): readonly {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
  readonly requirement: string;
}[] {
  if (
    !isRecord(policy) ||
    !isRecord(policy.channels) ||
    !Array.isArray(policy.channels.denyRules)
  ) {
    return [];
  }
  return policy.channels.denyRules
    .map((rule, index) => ({ rule, index }))
    .filter(
      (
        entry,
      ): entry is {
        readonly index: number;
        readonly rule: {
          readonly id?: string;
          readonly when?: { readonly provider?: string };
          readonly reason?: string;
        };
      } => isChannelDenyRule(entry.rule),
    )
    .map(({ rule, index }) => {
      const next: {
        id?: string;
        when?: { readonly provider?: string };
        reason?: string;
        requirement: string;
      } = {
        when: rule.when,
        requirement: `oc://${policyDocName}/channels/denyRules/#${index}`,
      };
      if (rule.id !== undefined) {
        next.id = rule.id;
      }
      if (rule.reason !== undefined) {
        next.reason = rule.reason;
      }
      return next;
    });
}

export function isChannelDenyRule(value: unknown): value is {
  readonly id?: string;
  readonly when?: { readonly provider?: string };
  readonly reason?: string;
} {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    isRecord(value.when) &&
    typeof value.when.provider === "string"
  );
}

export function channelIdsFromFindings(findings: readonly HealthFinding[]): readonly string[] {
  return [
    ...new Set(
      findings
        .filter((finding) => finding.checkId === CHECK_IDS.policyDeniedChannelProvider)
        .map((finding) => finding.ocPath?.match(/^oc:\/\/openclaw\.config\/channels\/(.+)$/)?.[1])
        .filter((id): id is string => id !== undefined && id !== ""),
    ),
  ];
}

export function disableChannels(
  cfg: HealthCheckContext["cfg"],
  channelIds: readonly string[],
): { readonly config: HealthCheckContext["cfg"]; readonly changed: readonly string[] } {
  if (!isRecord(cfg.channels)) {
    return { config: cfg, changed: [] };
  }
  const channels: Record<string, unknown> = { ...cfg.channels };
  const changed: string[] = [];
  for (const id of channelIds) {
    const current = channels[id];
    if (!isRecord(current) || current.enabled === false) {
      continue;
    }
    channels[id] = { ...current, enabled: false };
    changed.push(id);
  }
  if (changed.length === 0) {
    return { config: cfg, changed };
  }
  return { config: { ...cfg, channels }, changed };
}

export type PolicySettings = {
  readonly enabled?: boolean;
  readonly workspaceRepairs?: boolean;
  readonly expectedHash?: string;
  readonly expectedAttestationHash?: string;
  readonly path?: string;
};

export function policySettings(ctx: HealthCheckContext): PolicySettings {
  const pluginConfig = ctx.cfg.plugins?.entries?.["policy"]?.config;
  if (!isRecord(pluginConfig)) {
    return {};
  }
  return pluginConfig;
}

export function policyChecksEnabled(ctx: HealthCheckContext, settings: PolicySettings): boolean {
  const entry = ctx.cfg.plugins?.entries?.["policy"];
  if (!isRecord(entry) || entry.enabled === false) {
    return false;
  }
  return settings.enabled !== false;
}

export function requiredToolMetadata(policy: unknown): ReadonlySet<string> {
  return new Set(readPolicyStringArray(policy, ["tools", "requireMetadata"]) ?? []);
}

export function requiredAuthProfileMetadata(
  policy: unknown,
): ReadonlySet<(typeof SUPPORTED_AUTH_PROFILE_METADATA)[number]> {
  const entries = readPolicyStringArray(policy, ["auth", "profiles", "requireMetadata"]) ?? [];
  return new Set(
    entries.filter((entry): entry is (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number] =>
      SUPPORTED_AUTH_PROFILE_METADATA.includes(
        entry as (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
      ),
    ),
  );
}

export function authProfileHasMetadata(
  profile: PolicyAuthProfileEvidence,
  metadata: (typeof SUPPORTED_AUTH_PROFILE_METADATA)[number],
): boolean {
  if (metadata === "provider") {
    return profile.provider !== undefined && profile.provider.trim() !== "";
  }
  return SUPPORTED_AUTH_PROFILE_MODES.includes(
    profile.mode as (typeof SUPPORTED_AUTH_PROFILE_MODES)[number],
  );
}

function policyToolGlobMatches(tool: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(tool);
}

export function toolListCoversTool(list: readonly string[], tool: string): boolean {
  for (const entry of list) {
    const normalized = normalizePolicyToolName(entry);
    if (normalized === "*" || normalized === tool) {
      return true;
    }
    if (POLICY_TOOL_GROUPS[normalized]?.includes(tool)) {
      return true;
    }
    if (normalized.includes("*") && policyToolGlobMatches(tool, normalized)) {
      return true;
    }
  }
  return false;
}

export function expandPolicyToolRequirement(value: string): readonly string[] {
  const normalized = normalizePolicyToolName(value);
  return POLICY_TOOL_GROUPS[normalized] ?? [normalized];
}

function normalizePolicyToolName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bash") {
    return "exec";
  }
  if (normalized === "apply-patch") {
    return "apply_patch";
  }
  return normalized;
}

export function normalizePolicyChannelId(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalExecApprovalsPath(): string {
  return "~/.openclaw/exec-approvals.json";
}

function execApprovalsArtifactLocation(ctx: HealthCheckContext): {
  readonly path: string;
  readonly displayName: string;
} {
  const stateDir = normalizedEnvValue(process.env.OPENCLAW_STATE_DIR);
  if (stateDir !== undefined) {
    const path = resolve(resolvePolicyStateDir(stateDir), "exec-approvals.json");
    return { path, displayName: path };
  }
  return {
    path: resolvePolicyArtifactPath(ctx, canonicalExecApprovalsPath()),
    displayName: canonicalExecApprovalsPath(),
  };
}

export function execApprovalsDisplayName(): string {
  const stateDir = normalizedEnvValue(process.env.OPENCLAW_STATE_DIR);
  if (stateDir === undefined) {
    return canonicalExecApprovalsPath();
  }
  return resolve(resolvePolicyStateDir(stateDir), "exec-approvals.json");
}

function resolvePolicyStateDir(stateDir: string): string {
  return stateDir.startsWith("~") ? resolvePolicyHomeRelativePath(stateDir) : resolve(stateDir);
}

function policyPathSetting(ctx: HealthCheckContext): string {
  const configured = policySettings(ctx).path;
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : "policy.jsonc";
}

export function policyDisplayName(ctx: HealthCheckContext): string {
  const configured = policyPathSetting(ctx);
  return isAbsolute(configured) ? basename(configured) : configured;
}
