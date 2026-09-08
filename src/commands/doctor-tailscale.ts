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

function result(config: OpenClawConfig, warnings: string[] = []): DoctorTailscaleMigrationResult {
  return { config, changes: [], warnings };
}

export async function prepareTailscaleConfigMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runCommandWithTimeout?: TailscaleStatusCommandRunner;
}): Promise<DoctorTailscaleMigrationResult> {
  const config = params.cfg;
  const gateway = config.gateway;
  const managed = (gateway?.tailscale?.mode ?? "off") !== "off";
  if (gateway?.tailscale?.mode === "serve" && gateway.tailscale.preserveFunnel) {
    return result(config);
  }
  if (!gateway || gateway.mode === "remote" || (!managed && gateway.bind !== "lan")) {
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
    managed,
  );
  if (inspection.status === "unavailable") {
    return result(config);
  }
  if (inspection.status === "invalid") {
    return result(config, [
      "Tailscale Serve status could not be parsed, so legacy Serve configuration was not changed. Review `tailscale serve status --json`, then rerun Doctor.",
    ]);
  }
  if (inspection.urls.length === 0) {
    return result(config);
  }

  if (managed) {
    return result(
      config,
      inspection.urls.some((url) => !new URL(url).port)
        ? [
            "The predecessor Tailscale route will be adopted from a previous OpenClaw release when the Gateway starts.",
          ]
        : [],
    );
  }
  const cleanup = inspection.urls
    .map(
      (url) => `\`tailscale serve --yes --https=${new URL(url).port || "443"} --set-path=/ off\``,
    )
    .join(" or ");
  // Disabled managed ingress is an external-owner choice, not an upgrade signal.
  return result(config, [
    `Legacy Tailscale Serve still targets Gateway port ${gatewayPort}, but Doctor cannot prove that OpenClaw owns the existing route; configuration was not changed. If you confirm the route belongs to the current Tailscale hostname and is stale from an older OpenClaw release, remove only its root handler with ${cleanup}, then configure gateway.bind="loopback" and gateway.tailscale.mode="serve" manually and restart the Gateway. If another service owns the route, leave managed Tailscale ingress off and configure gateway.trustedProxies for that proxy instead.`,
  ]);
}
