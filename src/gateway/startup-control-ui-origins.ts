import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  type GatewayNonLoopbackBindMode,
} from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isContainerEnvironment } from "./net.js";

export async function maybeSeedControlUiAllowedOriginsAtStartup(params: {
  config: OpenClawConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  runtimeBind?: unknown;
  runtimePort?: unknown;
}): Promise<{ config: OpenClawConfig; seededAllowedOrigins: boolean }> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.config, {
    isContainerEnvironment,
    runtimeBind: params.runtimeBind,
    runtimePort: params.runtimePort,
  });
  if (!seeded.seededOrigins || !seeded.bind) {
    return { config: params.config, seededAllowedOrigins: false };
  }
  params.log.info(buildSeededOriginsInfoLog(seeded.seededOrigins, seeded.bind));
  return { config: seeded.config, seededAllowedOrigins: true };
}

function buildSeededOriginsInfoLog(origins: string[], bind: GatewayNonLoopbackBindMode): string {
  return (
    `gateway: seeded gateway.controlUi.allowedOrigins ${JSON.stringify(origins)} ` +
    `for bind=${bind} (required since v2026.2.26; see issue #29385). ` +
    "Applied for this runtime without writing config; add other origins to gateway.controlUi.allowedOrigins if needed."
  );
}
