// Doctor migration for shipped external Tailscale Serve routes.
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

function unchanged(
  config: OpenClawConfig,
  warnings: string[] = [],
): DoctorTailscaleMigrationResult {
  return { config, changes: [], warnings };
}

function isCanonicalServeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "wss:" && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

export async function prepareLegacyTailscaleServeConfigMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runCommandWithTimeout?: TailscaleStatusCommandRunner;
}): Promise<DoctorTailscaleMigrationResult> {
  const gateway = params.cfg.gateway;
  if (
    !gateway ||
    gateway.mode === "remote" ||
    gateway.bind !== "lan" ||
    (gateway.tailscale?.mode ?? "off") !== "off"
  ) {
    return unchanged(params.cfg);
  }

  const gatewayPort = resolveGatewayPort(params.cfg, params.env ?? process.env);
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
    return unchanged(params.cfg);
  }
  if (inspection.status === "invalid") {
    return unchanged(params.cfg, [
      "Tailscale Serve status could not be parsed, so legacy Serve configuration was not changed. Review `tailscale serve status --json`, then rerun Doctor.",
    ]);
  }
  if (inspection.urls.length === 0) {
    return unchanged(params.cfg);
  }

  // The managed startup command owns the device's default HTTPS root. Custom ports
  // and Services need an operator-selected target, so Doctor must not guess at them.
  const migrationIsUnambiguous =
    inspection.urls.length === 1 &&
    isCanonicalServeUrl(inspection.urls[0] ?? "") &&
    !gateway.tailscale?.serviceName &&
    gateway.auth?.mode !== "none";
  if (!migrationIsUnambiguous) {
    return unchanged(params.cfg, [
      `Legacy Tailscale Serve still targets Gateway port ${gatewayPort}, but its custom endpoint, Service, or disabled authentication cannot be migrated safely; configuration was not changed. Remove that route or configure gateway.bind="loopback" and gateway.tailscale.mode="serve" manually.`,
    ]);
  }

  const { preserveFunnel: _preserveFunnel, ...tailscale } = gateway.tailscale ?? {};
  return {
    config: {
      ...params.cfg,
      gateway: {
        ...gateway,
        bind: "loopback",
        tailscale: { ...tailscale, mode: "serve" },
      },
    },
    changes: [
      `Migrated legacy Tailscale Serve on port ${gatewayPort} to managed Tailscale Serve ingress (gateway.bind="loopback", gateway.tailscale.mode="serve"); restart the Gateway to claim the route.`,
    ],
    warnings: [],
  };
}
