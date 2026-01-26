import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
} from "./defaults.js";
import { VERSION } from "../version.js";
import { MissingEnvVarError, resolveConfigEnvVars } from "./env-substitution.js";
import { collectConfigEnvVars } from "./env-vars.js";
import { ConfigIncludeError, resolveConfigIncludes } from "./includes.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import { resolveConfigPath, resolveStateDir } from "./paths.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { ClawdbotConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";
import { compareClawdbotVersions } from "./version.js";

// Re-export for backwards compatibility
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "SYNTHETIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
];

const CONFIG_BACKUP_COUNT = 5;
const loggedInvalidConfigs = new Set<string>();

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) return trimmed;
  }
  if (typeof snapshot.raw !== "string") return null;
  return hashConfigRaw(snapshot.raw);
}

function coerceConfig(value: unknown): ClawdbotConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as ClawdbotConfig;
}

async function rotateConfigBackups(configPath: string, ioFs: typeof fs.promises): Promise<void> {
  if (CONFIG_BACKUP_COUNT <= 1) return;
  const backupBase = `${configPath}.bak`;
  const maxIndex = CONFIG_BACKUP_COUNT - 1;
  await ioFs.unlink(`${backupBase}.${maxIndex}`).catch(() => {
    // best-effort
  });
  for (let index = maxIndex - 1; index >= 1; index -= 1) {
    await ioFs.rename(`${backupBase}.${index}`, `${backupBase}.${index + 1}`).catch(() => {
      // best-effort
    });
  }
  await ioFs.rename(backupBase, `${backupBase}.1`).catch(() => {
    // best-effort
  });
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") return;
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return;
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function stampConfigVersion(cfg: ClawdbotConfig): ClawdbotConfig {
  const now = new Date().toISOString();
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: now,
    },
  };
}

function warnIfConfigFromFuture(cfg: ClawdbotConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) return;
  const cmp = compareClawdbotVersions(VERSION, touched);
  if (cmp === null) return;
  if (cmp < 0) {
    logger.warn(
      `Config was last written by a newer Clawdbot (${touched}); current version is ${VERSION}.`,
    );
  }
}

function applyConfigEnv(cfg: ClawdbotConfig, env: NodeJS.ProcessEnv): void {
  const entries = collectConfigEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    if (env[key]?.trim()) continue;
    env[key] = value;
  }
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) return deps.configPath;
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? os.homedir,
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const configPath = resolveConfigPathForDeps(deps);

  function loadConfig(): ClawdbotConfig {
    try {
      if (!deps.fs.existsSync(configPath)) {
        if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) {
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            expectedKeys: SHELL_ENV_EXPECTED_KEYS,
            logger: deps.logger,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);

      // Resolve $include directives before validation
      const resolved = resolveConfigIncludes(parsed, configPath, {
        readFile: (p) => deps.fs.readFileSync(p, "utf-8"),
        parseJson: (raw) => deps.json5.parse(raw),
      });

      // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars
      if (resolved && typeof resolved === "object" && "env" in resolved) {
        applyConfigEnv(resolved as ClawdbotConfig, deps.env);
      }

      // Substitute ${VAR} env var references
      const substituted = resolveConfigEnvVars(resolved, deps.env);

      const resolvedConfig = substituted;
      warnOnConfigMiskeys(resolvedConfig, deps.logger);
      if (typeof resolvedConfig !== "object" || resolvedConfig === null) return {};
      const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig as ClawdbotConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      const validated = validateConfigObjectWithPlugins(resolvedConfig);
      if (!validated.ok) {
        const details = validated.issues
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        if (!loggedInvalidConfigs.has(configPath)) {
          loggedInvalidConfigs.add(configPath);
          deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
        }
        const error = new Error("Invalid config");
        (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
        (error as { code?: string; details?: string }).details = details;
        throw error;
      }
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map((iss) => `- ${iss.path || "<root>"}: ${iss.message}`)
          .join("\n");
        deps.logger.warn(`Config warnings:\\n${details}`);
      }
      warnIfConfigFromFuture(validated.config, deps.logger);
      const cfg = applyModelDefaults(
        applyCompactionDefaults(
          applyContextPruningDefaults(
            applyAgentDefaults(
              applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
            ),
          ),
        ),
      );
      normalizeConfigPaths(cfg);

      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      applyConfigEnv(cfg, deps.env);

      const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
      if (enabled && !shouldDeferShellEnvFallback(deps.env)) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      return applyConfigOverrides(cfg);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        return {};
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const hash = hashConfigRaw(null);
      const config = applyTalkApiKey(
        applyModelDefaults(
          applyCompactionDefaults(
            applyContextPruningDefaults(
              applyAgentDefaults(applySessionDefaults(applyMessageDefaults({}))),
            ),
          ),
        ),
      );
      const legacyIssues: LegacyConfigIssue[] = [];
      return {
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config,
        hash,
        issues: [],
        warnings: [],
        legacyIssues,
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const hash = hashConfigRaw(raw);
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: {},
          valid: false,
          config: {},
          hash,
          issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
          warnings: [],
          legacyIssues: [],
        };
      }

      // Resolve $include directives
      let resolved: unknown;
      try {
        resolved = resolveConfigIncludes(parsedRes.parsed, configPath, {
          readFile: (p) => deps.fs.readFileSync(p, "utf-8"),
          parseJson: (raw) => deps.json5.parse(raw),
        });
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: coerceConfig(parsedRes.parsed),
          hash,
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        };
      }

      // Apply config.env to process.env BEFORE substitution so ${VAR} can reference config-defined vars
      if (resolved && typeof resolved === "object" && "env" in resolved) {
        applyConfigEnv(resolved as ClawdbotConfig, deps.env);
      }

      // Substitute ${VAR} env var references
      let substituted: unknown;
      try {
        substituted = resolveConfigEnvVars(resolved, deps.env);
      } catch (err) {
        const message =
          err instanceof MissingEnvVarError
            ? err.message
            : `Env var substitution failed: ${String(err)}`;
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: coerceConfig(resolved),
          hash,
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        };
      }

      const resolvedConfigRaw = substituted;
      const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw);

      const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
      if (!validated.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: coerceConfig(resolvedConfigRaw),
          hash,
          issues: validated.issues,
          warnings: validated.warnings,
          legacyIssues,
        };
      }

      warnIfConfigFromFuture(validated.config, deps.logger);
      return {
        path: configPath,
        exists: true,
        raw,
        parsed: parsedRes.parsed,
        valid: true,
        config: normalizeConfigPaths(
          applyTalkApiKey(
            applyModelDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
        hash,
        issues: [],
        warnings: validated.warnings,
        legacyIssues,
      };
    } catch (err) {
      return {
        path: configPath,
        exists: true,
        raw: null,
        parsed: {},
        valid: false,
        config: {},
        hash: hashConfigRaw(null),
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        warnings: [],
        legacyIssues: [],
      };
    }
  }

  async function writeConfigFile(cfg: ClawdbotConfig) {
    clearConfigCache();
    const validated = validateConfigObjectWithPlugins(cfg);
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      throw new Error(`Config validation failed: ${pathLabel}: ${issue?.message ?? "invalid"}`);
    }
    if (validated.warnings.length > 0) {
      const details = validated.warnings
        .map((warning) => `- ${warning.path}: ${warning.message}`)
        .join("\n");
      deps.logger.warn(`Config warnings:\n${details}`);
    }
    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const json = JSON.stringify(applyModelDefaults(stampConfigVersion(cfg)), null, 2)
      .trimEnd()
      .concat("\n");

    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    await deps.fs.promises.writeFile(tmp, json, {
      encoding: "utf-8",
      mode: 0o600,
    });

    if (deps.fs.existsSync(configPath)) {
      await rotateConfigBackups(configPath, deps.fs.promises);
      await deps.fs.promises.copyFile(configPath, `${configPath}.bak`).catch(() => {
        // best-effort
      });
    }

    try {
      await deps.fs.promises.rename(tmp, configPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Windows doesn't reliably support atomic replace via rename when dest exists.
      if (code === "EPERM" || code === "EEXIST") {
        await deps.fs.promises.copyFile(tmp, configPath);
        await deps.fs.promises.chmod(configPath, 0o600).catch(() => {
          // best-effort
        });
        await deps.fs.promises.unlink(tmp).catch(() => {
          // best-effort
        });
        return;
      }
      await deps.fs.promises.unlink(tmp).catch(() => {
        // best-effort
      });
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    writeConfigFile,
  };
}

// NOTE: These wrappers intentionally do *not* cache the resolved config path at
// module scope. `CLAWDBOT_CONFIG_PATH` (and friends) are expected to work even
// when set after the module has been imported (tests, one-off scripts, etc.).
const DEFAULT_CONFIG_CACHE_MS = 200;
let configCache: {
  configPath: string;
  expiresAt: number;
  config: ClawdbotConfig;
} | null = null;

function resolveConfigCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAWDBOT_CONFIG_CACHE_MS?.trim();
  if (raw === "" || raw === "0") return 0;
  if (!raw) return DEFAULT_CONFIG_CACHE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG_CACHE_MS;
  return Math.max(0, parsed);
}

function shouldUseConfigCache(env: NodeJS.ProcessEnv): boolean {
  if (env.CLAWDBOT_DISABLE_CONFIG_CACHE?.trim()) return false;
  return resolveConfigCacheMs(env) > 0;
}

function clearConfigCache(): void {
  configCache = null;
}

export function loadConfig(): ClawdbotConfig {
  const configPath = resolveConfigPath();
  const now = Date.now();
  if (shouldUseConfigCache(process.env)) {
    const cached = configCache;
    if (cached && cached.configPath === configPath && cached.expiresAt > now) {
      return cached.config;
    }
  }
  const config = createConfigIO({ configPath }).loadConfig();
  if (shouldUseConfigCache(process.env)) {
    const cacheMs = resolveConfigCacheMs(process.env);
    if (cacheMs > 0) {
      configCache = {
        configPath,
        expiresAt: now + cacheMs,
        config,
      };
    }
  }
  return config;
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    configPath: resolveConfigPath(),
  }).readConfigFileSnapshot();
}

export async function writeConfigFile(cfg: ClawdbotConfig): Promise<void> {
  clearConfigCache();
  await createConfigIO({ configPath: resolveConfigPath() }).writeConfigFile(cfg);
}
