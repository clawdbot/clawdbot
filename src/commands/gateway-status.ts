import { withProgress } from "../cli/progress.js";
import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import { resolveWideAreaDiscoveryDomain } from "../infra/widearea-dns.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich } from "../terminal/theme.js";
import { inferSshTargetFromRemoteUrl, resolveSshTarget } from "./gateway-status/discovery.js";
import {
  buildNetworkHints,
  parseTimeoutMs,
  resolveTargets,
  sanitizeSshTarget,
} from "./gateway-status/helpers.js";
import {
  buildGatewayStatusWarnings,
  pickPrimaryProbedTarget,
  writeGatewayStatusJson,
  writeGatewayStatusText,
} from "./gateway-status/output.js";
import { runGatewayStatusProbePass } from "./gateway-status/probe-run.js";

let sshConfigModulePromise: Promise<typeof import("../infra/ssh-config.js")> | undefined;
let sshTunnelModulePromise: Promise<typeof import("../infra/ssh-tunnel.js")> | undefined;
let gatewayTlsModulePromise: Promise<typeof import("../infra/tls/gateway.js")> | undefined;

function loadSshConfigModule() {
  sshConfigModulePromise ??= import("../infra/ssh-config.js");
  return sshConfigModulePromise;
}

function loadSshTunnelModule() {
  sshTunnelModulePromise ??= import("../infra/ssh-tunnel.js");
  return sshTunnelModulePromise;
}

function loadGatewayTlsModule() {
  gatewayTlsModulePromise ??= import("../infra/tls/gateway.js");
  return gatewayTlsModulePromise;
}

export async function gatewayStatusCommand(
  opts: {
    url?: string;
    token?: string;
    password?: string;
    timeout?: unknown;
    json?: boolean;
    ssh?: string;
    sshIdentity?: string;
    sshAuto?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const startedAt = Date.now();
  const cfg = await readBestEffortConfig();
  const rich = isRich() && opts.json !== true;
  const defaultTimeoutMs = Math.max(3000, cfg.gateway?.handshakeTimeoutMs ?? 0);
  const overallTimeoutMs = parseTimeoutMs(opts.timeout, defaultTimeoutMs);
  const wideAreaDomain = resolveWideAreaDiscoveryDomain({
    configDomain: cfg.discovery?.wideArea?.domain,
  });
  const baseTargets = resolveTargets(cfg, opts.url);
  const network = buildNetworkHints(cfg);
  const remotePort = resolveGatewayPort(cfg);
  const discoveryTimeoutMs = Math.min(1200, overallTimeoutMs);

  let sshTarget = sanitizeSshTarget(opts.ssh) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshTarget);
  let sshIdentity =
    sanitizeSshTarget(opts.sshIdentity) ?? sanitizeSshTarget(cfg.gateway?.remote?.sshIdentity);

  if (!sshTarget) {
    sshTarget = inferSshTargetFromRemoteUrl(cfg.gateway?.remote?.url);
  }

  if (sshTarget) {
    const resolved = await resolveSshTarget({
      rawTarget: sshTarget,
      identity: sshIdentity,
      overallTimeoutMs,
      loadSshConfigModule,
      loadSshTunnelModule,
    });
    if (resolved) {
      sshTarget = resolved.target;
      if (!sshIdentity && resolved.identity) {
        sshIdentity = resolved.identity;
      }
    }
  }

  const localTlsRuntime =
    cfg.gateway?.tls?.enabled === true
      ? await loadGatewayTlsModule().then(({ loadGatewayTlsRuntime }) =>
          loadGatewayTlsRuntime(cfg.gateway?.tls),
        )
      : undefined;

  const probePass = await withProgress(
    {
      label: "Inspecting gateways…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await runGatewayStatusProbePass({
        cfg,
        opts,
        overallTimeoutMs,
        discoveryTimeoutMs,
        wideAreaDomain,
        baseTargets,
        remotePort,
        sshTarget,
        sshIdentity,
        loadSshTunnelModule,
        localTlsFingerprint: localTlsRuntime?.enabled
          ? localTlsRuntime.fingerprintSha256
          : undefined,
      }),
  );

  const warnings = buildGatewayStatusWarnings({
    probed: probePass.probed,
    sshTarget: probePass.sshTarget,
    sshTunnelStarted: probePass.sshTunnelStarted,
    sshTunnelError: probePass.sshTunnelError,
    localTlsLoadError:
      localTlsRuntime && !localTlsRuntime.enabled && localTlsRuntime.required
        ? (localTlsRuntime.error ?? "gateway tls is enabled but local TLS runtime could not load")
        : null,
  });
  const primary = pickPrimaryProbedTarget(probePass.probed);

  if (opts.json) {
    writeGatewayStatusJson({
      runtime,
      startedAt,
      overallTimeoutMs,
      discoveryTimeoutMs,
      network,
      discovery: probePass.discovery,
      probed: probePass.probed,
      warnings,
      primaryTargetId: primary?.target.id ?? null,
    });
    return;
  }

  writeGatewayStatusText({
    runtime,
    rich,
    overallTimeoutMs,
    wideAreaDomain,
    discovery: probePass.discovery,
    probed: probePass.probed,
    warnings,
  });
}
