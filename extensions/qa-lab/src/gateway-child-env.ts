// Qa Lab plugin module owns gateway child runtime environment behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyVitestResourceContextToChildEnv } from "openclaw/plugin-sdk/test-env";
import { buildQaCodexAppServerArgs } from "./codex-app-server-args.js";
import type { QaProviderMode } from "./model-selection.js";
import {
  normalizeQaProviderModeEnv,
  resolveQaLiveCliAuthEnv,
  type QaCliBackendAuthMode,
} from "./providers/env.js";
import { getQaProvider } from "./providers/index.js";
import {
  QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV,
  QA_LIVE_SETUP_TOKEN_VALUE_ENV,
} from "./providers/live-frontier/auth.js";
import { listMockCodexModelInfos } from "./providers/shared/mock-model-config.js";
import type { RuntimeId } from "./runtime-parity.js";

const QA_GATEWAY_CHILD_BLOCKED_ENV_VARS = Object.freeze([
  "BASH_ENV",
  "BASHOPTS",
  "ENV",
  "OPENCLAW_QA_CONVEX_SECRET_CI",
  "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER",
  "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL",
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
  "SHELLOPTS",
]);

function scrubQaGatewayChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const envKey of QA_GATEWAY_CHILD_BLOCKED_ENV_VARS) {
    delete env[envKey];
  }
  // Bash imports exported functions before the launcher can apply its allowlist.
  for (const envKey of Object.keys(env)) {
    if (envKey.startsWith("BASH_FUNC_")) {
      delete env[envKey];
    }
  }
  return env;
}

function scrubQaGatewayChildTestRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The Gateway is a product child, not a nested Vitest worker. Leaking runner
  // markers makes the dist launcher select test-only startup behavior.
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  return env;
}

export function buildQaRuntimeEnv(params: {
  configPath: string;
  gatewayToken: string;
  homeDir: string;
  forwardHostHome?: boolean;
  stateDir: string;
  tempRoot: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgCacheHome: string;
  bundledPluginsDir?: string;
  stagedBundledPluginsRoot?: string | null;
  compatibilityHostVersion?: string;
  providerMode?: QaProviderMode;
  baseEnv?: NodeJS.ProcessEnv;
  runtimeEnvPatch?: NodeJS.ProcessEnv;
  forwardHostHomeForClaudeCli?: boolean;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const baseEnv = params.baseEnv ?? process.env;
  const provider = params.providerMode ? getQaProvider(params.providerMode) : null;
  const forwardedHostHome = params.forwardHostHome
    ? baseEnv.HOME?.trim() || os.homedir()
    : undefined;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: forwardedHostHome ?? params.homeDir,
    ...(provider?.appliesLiveEnvAliases
      ? resolveQaLiveCliAuthEnv(baseEnv, {
          forwardHostHomeForClaudeCli: params.forwardHostHomeForClaudeCli,
          claudeCliAuthMode: params.claudeCliAuthMode,
        })
      : {}),
    OPENCLAW_HOME: params.homeDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_OAUTH_DIR: path.join(params.stateDir, "credentials"),
    OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_TEST_FAST: "1",
    OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "2000",
    OPENCLAW_QA_PARENT_PID: String(process.pid),
    OPENCLAW_QA_TEMP_ROOT: params.tempRoot,
    ...(params.stagedBundledPluginsRoot
      ? { OPENCLAW_QA_STAGED_RUNTIME_ROOT: params.stagedBundledPluginsRoot }
      : {}),
    OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
    // QA uses the fast runtime envelope for speed, but it still exercises
    // normal config-driven heartbeats and runtime config writes.
    OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
    XDG_CONFIG_HOME: params.xdgConfigHome,
    XDG_DATA_HOME: params.xdgDataHome,
    XDG_CACHE_HOME: params.xdgCacheHome,
    ...(params.bundledPluginsDir ? { OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir } : {}),
    ...(params.compatibilityHostVersion
      ? { OPENCLAW_COMPATIBILITY_HOST_VERSION: params.compatibilityHostVersion }
      : {}),
  };
  const normalizedEnv = normalizeQaProviderModeEnv(env, params.providerMode);
  // Test-runner skip flags are parent controls; each QA child declares its own runtime needs.
  delete normalizedEnv.OPENCLAW_SKIP_CHANNELS;
  delete normalizedEnv.OPENCLAW_SKIP_PROVIDERS;
  Object.assign(normalizedEnv, params.runtimeEnvPatch);
  applyVitestResourceContextToChildEnv(normalizedEnv);
  // Parent shell startup controls must be removed after caller patches so no
  // launcher or runtime child can import them before its own allowlist runs.
  normalizedEnv.OPENCLAW_BUILD_PRIVATE_QA = "1";
  delete normalizedEnv[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV];
  delete normalizedEnv[QA_LIVE_SETUP_TOKEN_VALUE_ENV];
  return scrubQaGatewayChildEnv(scrubQaGatewayChildTestRunnerEnv(normalizedEnv));
}

export async function stageQaCodexMockModelCatalog(params: {
  tempRoot: string;
  forcedRuntime?: RuntimeId;
  providerMode: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  autoCompactTokenLimit?: number;
}): Promise<string | undefined> {
  if (params.forcedRuntime !== "codex" || params.providerMode !== "mock-openai") {
    return undefined;
  }
  const modelCatalogPath = path.join(params.tempRoot, "codex-model-catalog.json");
  const selectedModelRefs = [params.primaryModel, params.alternateModel].filter(
    (model): model is string => typeof model === "string" && model.length > 0,
  );
  const models = listMockCodexModelInfos(selectedModelRefs);
  if (params.autoCompactTokenLimit !== undefined) {
    for (const model of models) {
      Object.assign(model, { auto_compact_token_limit: params.autoCompactTokenLimit });
    }
  }
  await fs.writeFile(modelCatalogPath, `${JSON.stringify({ models }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return modelCatalogPath;
}

export function buildQaForcedRuntimeEnvPatch(params: {
  forcedRuntime?: RuntimeId;
  providerMode: QaProviderMode;
  providerBaseUrl?: string;
  codexModelCatalogPath?: string;
  nativeAppServerArgs?: string;
}): NodeJS.ProcessEnv | undefined {
  if (!params.forcedRuntime) {
    return undefined;
  }
  const patch: NodeJS.ProcessEnv = {
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_QA_FORCE_RUNTIME: params.forcedRuntime,
  };
  if (params.forcedRuntime !== "codex") {
    return patch;
  }
  if (params.providerMode !== "mock-openai") {
    patch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
      existingArgs: params.nativeAppServerArgs,
    });
    return patch;
  }
  const providerBaseUrl = params.providerBaseUrl?.trim().replace(/\/+$/u, "");
  if (!providerBaseUrl) {
    throw new Error("forced Codex mock QA requires the managed mock provider URL");
  }
  if (!params.codexModelCatalogPath) {
    throw new Error("forced Codex mock QA requires the staged native model catalog");
  }
  patch.OPENCLAW_CODEX_APP_SERVER_ARGS = buildQaCodexAppServerArgs({
    providerBaseUrl,
    modelCatalogPath: params.codexModelCatalogPath,
  });
  return patch;
}
