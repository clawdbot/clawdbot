import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isContainerEnvironment } from "./net.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  writeConfig: (config: OpenClawConfig) => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  runtimeBind?: unknown;
  runtimePort?: unknown;
}): Promise<{ config: OpenClawConfig; persistedAllowedOriginsSeed: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
    isContainerEnvironment,
    runtimeBind: params.runtimeBind,
    runtimePort: params.runtimePort,
  });
  if (!seeded.seededOrigins || !seeded.bind) {
    return { config: params.config, persistedAllowedOriginsSeed: false };
  }
  try {
    await params.writeConfig(seeded.config);
    params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
    return { config: seeded.config, persistedAllowedOriginsSeed: true };
  } catch (err) {
    params.log.warn(
      `gateway: failed to persist gateway.controlUi.allowedOrigins seed: ${String(err)}. The gateway will start with the in-memory value but config was not saved.`,
    );
  }
  return { config: seeded.config, persistedAllowedOriginsSeed: false };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
