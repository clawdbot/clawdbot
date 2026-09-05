import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultGatewayBindMode, resolveGatewayRequiredListenHosts } from "../gateway/net.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../infra/ports-probe.js";
import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

export async function resolveGatewayServiceProbeHosts(params: {
  env?: GatewayServiceEnv;
  command?: GatewayServiceCommandConfig | null;
}): Promise<readonly string[]> {
  const baseEnv = params.env ?? process.env;
  const mergedEnv = mergeGatewayServiceEnv(baseEnv, params.command ?? null);
  const { createConfigIO } = await import("../config/io.runtime.js");
  const cfg = await createConfigIO({
    env: mergedEnv,
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  })
    .readBestEffortConfig()
    .catch((): OpenClawConfig => ({}));
  const bindMode =
    cfg.gateway?.bind ?? defaultGatewayBindMode(cfg.gateway?.tailscale?.mode ?? "off");
  const bindHost =
    bindMode === "lan"
      ? "0.0.0.0"
      : bindMode === "custom"
        ? cfg.gateway?.customBindHost?.trim() || "0.0.0.0"
        : bindMode === "tailnet"
          ? (pickPrimaryTailnetIPv4() ?? LOOPBACK_PORT_PROBE_HOSTS[0])
          : bindMode === "auto" && isContainerEnvironment()
            ? "0.0.0.0"
            : LOOPBACK_PORT_PROBE_HOSTS[0];
  return resolveGatewayRequiredListenHosts(bindHost);
}
