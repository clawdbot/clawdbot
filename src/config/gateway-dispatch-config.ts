import fs from "node:fs";
import path from "node:path";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { applyConfigEnvVars } from "./config-env-vars.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import { resolveConfigPath, resolveIncludeRoots } from "./paths.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const GATEWAY_DISPATCH_SHELL_ENV_EXPECTED_KEYS = [
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
] as const;

const GATEWAY_DISPATCH_TOP_LEVEL_KEYS = [
  "agents",
  "env",
  "gateway",
  "plugins",
  "secrets",
  "session",
] as const;

type GatewayDispatchConfigReadOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "warn" | "error">;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry));
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = cloneConfigValue(child);
  }
  return out;
}

function projectGatewayDispatchConfig(value: unknown): OpenClawConfig {
  if (!isPlainRecord(value)) {
    return {};
  }
  const projected: Record<string, unknown> = {};
  for (const key of GATEWAY_DISPATCH_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(value, key)) {
      projected[key] = cloneConfigValue(value[key]);
    }
  }
  return projected as OpenClawConfig;
}

function applyGatewayDispatchSessionDefaults(config: OpenClawConfig): OpenClawConfig {
  if (config.session?.mainKey === undefined) {
    return config;
  }
  return {
    ...config,
    session: { ...config.session, mainKey: "main" },
  };
}

function resolveIncludesForGatewayDispatch(
  parsed: unknown,
  configPath: string,
  env: NodeJS.ProcessEnv,
): unknown {
  return resolveConfigIncludes(
    parsed,
    configPath,
    {
      readFile: (candidate) => fs.readFileSync(candidate, "utf-8"),
      readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
        readConfigIncludeFileWithGuards({
          includePath,
          resolvedPath,
          rootRealDir,
          ioFs: fs,
        }),
      parseJson: parseJsonWithJson5Fallback,
    },
    { allowedRoots: resolveIncludeRoots(env) },
  );
}

function resolveGatewayDispatchEnvVars(config: unknown, env: NodeJS.ProcessEnv): unknown {
  if (isPlainRecord(config) && Object.hasOwn(config, "env")) {
    applyConfigEnvVars(config as OpenClawConfig, env);
  }
  return resolveConfigEnvVars(config, env, { onMissing: () => undefined });
}

function readRawGatewayDispatchConfig(options: GatewayDispatchConfigReadOptions = {}): {
  config: OpenClawConfig;
  configPath: string;
} {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return { config: {}, configPath };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = parseJsonWithJson5Fallback(raw);
  const resolvedIncludes = resolveIncludesForGatewayDispatch(parsed, configPath, env);
  const resolvedConfig = resolveGatewayDispatchEnvVars(resolvedIncludes, env);
  return {
    config: applyGatewayDispatchSessionDefaults(projectGatewayDispatchConfig(resolvedConfig)),
    configPath,
  };
}

export function readGatewayDispatchConfig(
  options: GatewayDispatchConfigReadOptions = {},
): OpenClawConfig {
  return readRawGatewayDispatchConfig(options).config;
}

export async function readGatewayDispatchConfigWithShellEnvFallback(
  options: GatewayDispatchConfigReadOptions = {},
): Promise<OpenClawConfig> {
  const env = options.env ?? process.env;
  const firstRead = readRawGatewayDispatchConfig(options);
  const {
    loadShellEnvFallback,
    resolveShellEnvFallbackTimeoutMs,
    shouldDeferShellEnvFallback,
    shouldEnableShellEnvFallback,
  } = await import("../infra/shell-env.js");
  const enabled =
    shouldEnableShellEnvFallback(env) || firstRead.config.env?.shellEnv?.enabled === true;
  if (enabled && !shouldDeferShellEnvFallback(env)) {
    loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: [...GATEWAY_DISPATCH_SHELL_ENV_EXPECTED_KEYS],
      logger: options.logger ?? console,
      timeoutMs: firstRead.config.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(env),
    });
  }
  return readGatewayDispatchConfig({ ...options, configPath: path.resolve(firstRead.configPath) });
}
