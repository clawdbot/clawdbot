import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import {
  DuplicateAgentDirError,
  findDuplicateAgentDirs,
} from "./agent-dirs.js";
import {
  applyContextPruningDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
} from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import {
  CONFIG_PATH_CLAWDBOT,
  resolveConfigPath,
  resolveStateDir,
} from "./paths.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type {
  ClawdbotConfig,
  ConfigFileSnapshot,
  LegacyConfigIssue,
} from "./types.js";
import { validateConfigObject } from "./validation.js";
import { ClawdbotSchema } from "./zod-schema.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "CLAWDBOT_GATEWAY_TOKEN",
  "CLAWDBOT_GATEWAY_PASSWORD",
];

export type ParseConfigJson5Result =
  | { ok: true; parsed: unknown }
  | { ok: false; error: string };

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

function warnOnConfigMiskeys(
  raw: unknown,
  logger: Pick<typeof console, "warn">,
): void {
  if (!raw || typeof raw !== "object") return;
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return;
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function applyConfigEnv(cfg: ClawdbotConfig, env: NodeJS.ProcessEnv): void {
  const envConfig = cfg.env;
  if (!envConfig) return;

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [key, value] of Object.entries(envConfig.vars)) {
      if (!value) continue;
      entries[key] = value;
    }
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "shellEnv" || key === "vars") continue;
    if (typeof value !== "string" || !value.trim()) continue;
    entries[key] = value;
  }

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
        if (shouldEnableShellEnvFallback(deps.env)) {
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
      warnOnConfigMiskeys(parsed, deps.logger);
      if (typeof parsed !== "object" || parsed === null) return {};
      const validated = ClawdbotSchema.safeParse(parsed);
      if (!validated.success) {
        deps.logger.error("Invalid config:");
        for (const iss of validated.error.issues) {
          deps.logger.error(`- ${iss.path.join(".")}: ${iss.message}`);
        }
        return {};
      }
      const cfg = applyModelDefaults(
        applyContextPruningDefaults(
          applySessionDefaults(
            applyLoggingDefaults(
              applyMessageDefaults(validated.data as ClawdbotConfig),
            ),
          ),
        ),
      );

      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      applyConfigEnv(cfg, deps.env);

      const enabled =
        shouldEnableShellEnvFallback(deps.env) ||
        cfg.env?.shellEnv?.enabled === true;
      if (enabled) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs:
            cfg.env?.shellEnv?.timeoutMs ??
            resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      return applyConfigOverrides(cfg);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const config = applyTalkApiKey(
        applyModelDefaults(
          applyContextPruningDefaults(
            applySessionDefaults(applyMessageDefaults({})),
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
        issues: [],
        legacyIssues,
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: {},
          valid: false,
          config: {},
          issues: [
            { path: "", message: `JSON5 parse failed: ${parsedRes.error}` },
          ],
          legacyIssues: [],
        };
      }

      const legacyIssues = findLegacyConfigIssues(parsedRes.parsed);

      const validated = validateConfigObject(parsedRes.parsed);
      if (!validated.ok) {
        return {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          valid: false,
          config: {},
          issues: validated.issues,
          legacyIssues,
        };
      }

      return {
        path: configPath,
        exists: true,
        raw,
        parsed: parsedRes.parsed,
        valid: true,
        config: applyTalkApiKey(
          applyModelDefaults(
            applySessionDefaults(
              applyLoggingDefaults(applyMessageDefaults(validated.config)),
            ),
          ),
        ),
        issues: [],
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
        issues: [{ path: "", message: `read failed: ${String(err)}` }],
        legacyIssues: [],
      };
    }
  }

  async function writeConfigFile(cfg: ClawdbotConfig) {
    await deps.fs.promises.mkdir(path.dirname(configPath), {
      recursive: true,
    });
    const json = JSON.stringify(applyModelDefaults(cfg), null, 2)
      .trimEnd()
      .concat("\n");
    await deps.fs.promises.writeFile(configPath, json, "utf-8");
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    writeConfigFile,
  };
}

const defaultIO = createConfigIO({ configPath: CONFIG_PATH_CLAWDBOT });

export const loadConfig = defaultIO.loadConfig;
export const readConfigFileSnapshot = defaultIO.readConfigFileSnapshot;
export const writeConfigFile = defaultIO.writeConfigFile;
