// Doctor diagnoses external Serve routes without taking over their ownership.
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  inspectTailscaleServeGatewayUrlsWithRunner,
  type TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";

type DoctorTailscaleMigrationResult = {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

function result(
  config: OpenClawConfig,
  changes: string[] = [],
  warnings: string[] = [],
): DoctorTailscaleMigrationResult {
  return { config, changes, warnings };
}

export async function prepareTailscaleConfigMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runCommandWithTimeout?: TailscaleStatusCommandRunner;
}): Promise<DoctorTailscaleMigrationResult> {
  const config = params.cfg;
  const gateway = config.gateway;
  if (
    !gateway ||
    gateway.mode === "remote" ||
    gateway.bind !== "lan" ||
    (gateway.tailscale?.mode ?? "off") !== "off"
  ) {
    return result(config);
  }

  const gatewayPort = resolveGatewayPort(config, params.env ?? process.env);
  const runCommandWithTimeout: TailscaleStatusCommandRunner =
    params.runCommandWithTimeout ??
    ((argv, options) =>
      runUtf8CommandWithTimeout(argv, {
        ...options,
        maxOutputBytes: 400_000,
      }));
  const inspection = await inspectTailscaleServeGatewayUrlsWithRunner(
    gatewayPort,
    runCommandWithTimeout,
  );
  if (inspection.status === "unavailable") {
    return result(config);
  }
  if (inspection.status === "invalid") {
    return result(
      config,
      [],
      [
        "Tailscale Serve status could not be parsed, so legacy Serve configuration was not changed. Inspect `tailscale serve status --json` and repair the external route through its owner.",
      ],
    );
  }
  if (inspection.urls.length === 0) {
    return result(config);
  }

  // A matching persistent route does not prove OpenClaw ownership. Enabling
  // managed ingress here makes startup reject the same route as an unowned claim.
  return result(
    config,
    [],
    [
      `External Tailscale Serve targets Gateway port ${gatewayPort}; configuration was not changed. Keep gateway.tailscale.mode="off" and configure gateway.trustedProxies for the external route. To choose managed Serve, configure token, password, or trusted-proxy authentication, inspect and remove only the route you intend to replace, then explicitly select gateway.bind="loopback" and gateway.tailscale.mode="serve". See https://docs.openclaw.ai/gateway/tailscale#externally-managed-serve-and-funnel.`,
    ],
  );
}
