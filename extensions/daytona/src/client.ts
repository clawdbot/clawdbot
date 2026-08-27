// Daytona API client construction, credential resolution, and transient-error retry.
import type { Daytona, Sandbox } from "@daytona/sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/sandbox";
import { resolveConfiguredSecretInputWithFallback } from "openclaw/plugin-sdk/secret-input-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedDaytonaPluginConfig } from "./config.js";

export type { Daytona, Sandbox };

type DaytonaConnection = {
  apiKey: string;
  apiUrl?: string;
  target?: string;
};

const DAYTONA_API_KEY_PATH = "plugins.entries.daytona.config.apiKey";

/** Resolve the Daytona connection settings from plugin config with env fallbacks. */
export async function resolveDaytonaConnection(params: {
  config: OpenClawConfig;
  pluginConfig: ResolvedDaytonaPluginConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<DaytonaConnection> {
  const env = params.env ?? process.env;
  const resolved = await resolveConfiguredSecretInputWithFallback({
    config: params.config,
    env,
    value: params.pluginConfig.apiKey,
    path: DAYTONA_API_KEY_PATH,
    readFallback: () => env.DAYTONA_API_KEY,
  });
  if (!resolved.value) {
    throw new Error(
      [
        "Daytona sandbox backend needs an API key.",
        resolved.unresolvedRefReason ??
          `Set ${DAYTONA_API_KEY_PATH} or export DAYTONA_API_KEY in the Gateway environment.`,
      ].join(" "),
    );
  }
  return {
    apiKey: resolved.value,
    apiUrl: params.pluginConfig.apiUrl ?? (env.DAYTONA_API_URL?.trim() || undefined),
    target: params.pluginConfig.target ?? (env.DAYTONA_TARGET?.trim() || undefined),
  };
}

type DaytonaSdkModule = typeof import("@daytona/sdk");

let daytonaSdkModule: Promise<DaytonaSdkModule> | undefined;

// The Daytona SDK pulls a large HTTP/client dependency tree, so it stays a
// lazy import to keep plugin registration and discovery loads light.
async function loadDaytonaSdk(): Promise<DaytonaSdkModule> {
  daytonaSdkModule ??= import("@daytona/sdk");
  return await daytonaSdkModule;
}

export async function createDaytonaClient(connection: DaytonaConnection): Promise<Daytona> {
  const sdk = await loadDaytonaSdk();
  return new sdk.Daytona({
    apiKey: connection.apiKey,
    apiUrl: connection.apiUrl,
    target: connection.target,
  });
}

function readDaytonaStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/** True when a Daytona API error means the sandbox or resource does not exist. */
export function isDaytonaNotFoundError(error: unknown): boolean {
  return readDaytonaStatusCode(error) === 404;
}

function isTransientDaytonaError(error: unknown): boolean {
  const statusCode = readDaytonaStatusCode(error);
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return true;
  }
  const code = isRecord(error) ? error.code : undefined;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

const TRANSIENT_RETRY_DELAYS_MS = [300, 900];

/** Retry short idempotent Daytona control-plane calls across transient API failures. */
export async function withDaytonaRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransientDaytonaError(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, TRANSIENT_RETRY_DELAYS_MS[attempt]);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
