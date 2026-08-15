// Loads state-directory dotenv entries used by config and runtime startup.
import fs from "node:fs";
import path from "node:path";
import { parse as parseDotEnv } from "dotenv";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { collectConfigServiceEnvVars } from "./config-env-vars.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "./future-version-guard.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

/** Maximum bytes to read from the state-directory .env file. */
const MAX_STATE_DIR_DOTENV_BYTES = 1024 * 1024;
const log = createSubsystemLogger("config/dotenv");

function isBlockedServiceEnvVar(key: string): boolean {
  return (
    key.toUpperCase() === ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV ||
    isDangerousHostEnvVarName(key) ||
    isDangerousHostEnvOverrideVarName(key)
  );
}

function unwrapMatchingLiteralQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value.at(-1);
  if ((first === `"` || first === `'`) && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/** Returns true when a dotenv value is only a shell reference, not an expanded secret. */
export function isUnresolvedShellReference(value: string): boolean {
  const candidate = unwrapMatchingLiteralQuotes(value.trim());
  // Match only values whose entire content is a shell variable reference:
  //   $VAR_NAME          (simple reference, OpenClaw env-var style)
  //   ${VAR_NAME}        (brace-form reference)
  //   $(command)         (command substitution)
  // A real credential that merely contains a $ (e.g. "abc$2!", "$100") is NOT matched.
  return (
    /^\$[A-Z_][A-Z0-9_]*$/.test(candidate) ||
    /^\$\{[A-Z_][A-Z0-9_]*[^}]*\}$/.test(candidate) ||
    /^\$\([^)]*\)$/.test(candidate)
  );
}

type ParsedStateDirDotEnv = {
  /** Keys whose values are persisted to the managed service environment. */
  entries: Record<string, string>;
  /**
   * Keys that were dropped because their entire value was an unresolved shell
   * reference ($VAR, ${VAR}, or $(cmd)). These are still OpenClaw-managed keys:
   * a previously generated env file may carry a stale literal reference for them
   * that must be removed on re-stage rather than preserved as an operator secret.
   */
  skippedShellReferenceKeys: string[];
};

function parseStateDirDotEnvContent(content: string | Buffer): ParsedStateDirDotEnv {
  const entries: Record<string, string> = {};
  const skippedShellReferenceKeys: string[] = [];
  for (const [rawKey, value] of Object.entries(parseDotEnv(content))) {
    if (!value?.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedServiceEnvVar(key)) {
      continue;
    }
    // Skip values whose entire content is an unresolved shell variable reference
    // ($VAR, ${VAR}, or $(cmd)). dotenv does not expand them, so persisting them
    // into a single-quoted LaunchAgent/systemd env file would store the literal
    // reference string rather than the intended credential value.
    // Values that merely contain $ (e.g. a password like "abc$2!") are kept.
    if (isUnresolvedShellReference(value)) {
      skippedShellReferenceKeys.push(key);
      continue;
    }
    entries[key] = value;
  }
  return { entries, skippedShellReferenceKeys };
}

/**
 * Read and parse the state-dir `.env`, returning both the persisted entries and
 * the keys that were skipped because they held unresolved shell references. The
 * skipped keys are surfaced so generated service env files can remove stale
 * literal references for keys OpenClaw previously managed.
 */
export function readStateDirDotEnvFromStateDir(stateDir: string): ParsedStateDirDotEnv {
  const dotEnvPath = path.join(stateDir, ".env");
  try {
    // Resolve symlinks so a .env file that points to a regular file keeps
    // working while the bounded read still rejects oversized targets.
    const resolved = fs.realpathSync(dotEnvPath);
    const { buffer } = readRegularFileSync({
      filePath: resolved,
      maxBytes: MAX_STATE_DIR_DOTENV_BYTES,
    });
    return parseStateDirDotEnvContent(buffer);
  } catch (err) {
    // Surface oversized files so operators know a configured .env was
    // skipped — unlike parse or permission errors which mean the file is
    // genuinely unusable.
    if (err instanceof Error && err.message.startsWith("File exceeds")) {
      log.warn(
        `skipping oversized state-directory .env file (max ${MAX_STATE_DIR_DOTENV_BYTES} bytes): ${dotEnvPath}`,
      );
    }
    return { entries: {}, skippedShellReferenceKeys: [] };
  }
}

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for a managed service
 * environment source.
 */
function readStateDirDotEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  return readStateDirDotEnvFromStateDir(stateDir).entries;
}

/** Split view of durable gateway service env sources before precedence is applied. */
type DurableServiceEnvVarSources = {
  stateDirDotEnvEnvironment: Record<string, string>;
  configEnvironment: Record<string, string>;
  durableEnvironment: Record<string, string>;
};

/** Collects durable service env vars from state-dir `.env` and config, preserving each source. */
export function collectDurableServiceEnvVarSources(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): DurableServiceEnvVarSources {
  const stateDirDotEnvEnvironment = readStateDirDotEnvVars(params.env);
  const configEnvironment = collectConfigServiceEnvVars(params.config);
  return {
    stateDirDotEnvEnvironment,
    configEnvironment,
    durableEnvironment: {
      ...stateDirDotEnvEnvironment,
      ...configEnvironment,
    },
  };
}

/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into owner-only gateway service environment sources.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export function collectDurableServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): Record<string, string> {
  return collectDurableServiceEnvVarSources(params).durableEnvironment;
}
