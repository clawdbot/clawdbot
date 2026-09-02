import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

let gatewayTestSeq = 0;

export const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

export function nextGatewayId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${gatewayTestSeq++}`;
}

async function createEmptyBundledPluginsDir(tempHome: string): Promise<string> {
  const bundledPluginsDir = path.join(tempHome, "openclaw-test-empty-bundled-plugins");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  return bundledPluginsDir;
}

export async function createGatewayConfigPath(tempHome: string): Promise<string> {
  const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  return configPath;
}

export async function removeGatewayTempHome(tempHome: string): Promise<void> {
  await fs.rm(tempHome, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

export async function setupGatewayTempHome(params: { prefix: string; minimalGateway?: boolean }) {
  const envSnapshot = captureEnv([...GATEWAY_TEST_ENV_KEYS]);

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), params.prefix));
  setTestEnvValue("HOME", tempHome);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
  deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  if (params.minimalGateway) {
    setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
  } else {
    deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
  }

  const workspaceDir = path.join(tempHome, "openclaw");
  await fs.mkdir(workspaceDir, { recursive: true });
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", await createEmptyBundledPluginsDir(tempHome));
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  return { envSnapshot, tempHome, workspaceDir };
}

export function resetGatewayTestState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}
