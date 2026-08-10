import path from "node:path";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "./test-helpers.env.js";

const MANUAL_GATEWAY_BACKGROUND_ENV_KEYS = [
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
] as const;

export const MANUAL_GATEWAY_ENV_KEYS = [
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  ...MANUAL_GATEWAY_BACKGROUND_ENV_KEYS,
] as const;

/** Keeps manual RPC suites on the real core Gateway without unrelated startup work. */
export function configureManualGatewayBackgroundEnv(tempHome: string): void {
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(tempHome, "no-plugins"));
}
