import type { MoltbotConfig } from "../config/config.js";

const DIAGNOSTICS_ENV = "CLAWDBOT_DIAGNOSTICS";

function normalizeFlag(value: string): string {
  return value.trim().toLowerCase();
}

function parseEnvFlags(raw?: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const lowered = trimmed.toLowerCase();
  if (["0", "false", "off", "none"].includes(lowered)) return [];
  if (["1", "true", "all", "*"].includes(lowered)) return ["*"];
  return trimmed
    .split(/[,\s]+/)
    .map(normalizeFlag)
    .filter(Boolean);
}

function uniqueFlags(flags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const flag of flags) {
    const normalized = normalizeFlag(flag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveDiagnosticFlags(
  cfg?: MoltbotConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
  const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
  return uniqueFlags([...configFlags, ...envFlags]);
}

export function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean {
  const target = normalizeFlag(flag);
  if (!target) return false;
  for (const raw of enabledFlags) {
    const enabled = normalizeFlag(raw);
    if (!enabled) continue;
    if (enabled === "*" || enabled === "all") return true;
    if (enabled.endsWith(".*")) {
      const prefix = enabled.slice(0, -2);
      if (target === prefix || target.startsWith(`${prefix}.`)) return true;
    }
    if (enabled.endsWith("*")) {
      const prefix = enabled.slice(0, -1);
      if (target.startsWith(prefix)) return true;
    }
    if (enabled === target) return true;
  }
  return false;
}

export function isDiagnosticFlagEnabled(
  flag: string,
  cfg?: MoltbotConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flags = resolveDiagnosticFlags(cfg, env);
  return matchesDiagnosticFlag(flag, flags);
}
