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
  applyIdentityDefaults,
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
        applySessionDefaults(
          applyLoggingDefaults(
            applyMessageDefaults(
              applyIdentityDefaults(validated.data as ClawdbotConfig),
            ),
          ),
        ),
      );

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

      return cfg;
    } catch (err) {
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      return {};
    }
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      const config = applyTalkApiKey(
        applyModelDefaults(applySessionDefaults(applyMessageDefaults({}))),
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
