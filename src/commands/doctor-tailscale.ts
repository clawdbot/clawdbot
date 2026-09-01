// Doctor migration for Tailscale config and shipped external Serve routes.
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
        "Tailscale Serve status could not be parsed, so legacy Serve configuration was not changed. Review `tailscale serve status --json`, then rerun Doctor.",
      ],
    );
  }
  if (inspection.urls.length === 0) {
    return result(config);
  }

  // Tailscale status describes the route but does not prove that OpenClaw owns
  // it. Gateway startup deliberately fails closed when it cannot prove that
  // ownership, so Doctor must not persist managed ingress based on shape alone.
  return result(
    config,
    [],
    [
      `Legacy Tailscale Serve still targets Gateway port ${gatewayPort}, but Doctor cannot prove that OpenClaw owns the existing route; configuration was not changed. If you confirm it is a stale route from an older OpenClaw release, remove only its root handler with \`tailscale serve --yes --https=443 --set-path=/ off\` or \`tailscale funnel --yes --https=443 --set-path=/ off\`, then configure gateway.bind="loopback" and gateway.tailscale.mode="serve" manually and restart the Gateway. If another service owns the route, leave managed Tailscale ingress off and configure gateway.trustedProxies for that proxy instead.`,
    ],
  );
}
