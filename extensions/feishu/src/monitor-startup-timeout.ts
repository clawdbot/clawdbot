import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

const FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS = 30_000;
const FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV = "OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS";

export function resolveStartupProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV];
  if (raw) {
    const parsed = parseStrictPositiveInteger(raw);
    if (parsed !== undefined) {
      return parsed;
    }
    console.warn(
      `[feishu] ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_ENV}="${raw}" is invalid; using default ${FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS}ms`,
    );
  }
  return FEISHU_STARTUP_BOT_INFO_TIMEOUT_DEFAULT_MS;
}
