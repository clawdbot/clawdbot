import type { OpenClawConfig } from "../../config/types.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  discoverGatewayBeacons,
  type GatewayBonjourBeacon,
} from "../../infra/bonjour-discovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { pickAutoSshTargetFromDiscovery } from "./discovery.js";
import {
  extractConfigSummary,
  pickGatewaySelfPresence,
  resolveAuthForTarget,
  resolveProbeBudgetMs,
  type GatewayConfigSummary,
  type GatewayStatusTarget,
} from "./helpers.js";

export type GatewayStatusProbedTarget = {
  target: GatewayStatusTarget;
  probe: Awaited<ReturnType<typeof probeGateway>>;
  configSummary: GatewayConfigSummary | null;
  self: ReturnType<typeof pickGatewaySelfPresence>;
  authDiagnostics: string[];
};

export async function runGatewayStatusProbePass(params: {
  cfg: OpenClawConfig;
  opts: {
    token?: string;
    password?: string;
    sshAuto?: boolean;
  };
  overallTimeoutMs: number;
  discoveryTimeoutMs: number;
  wideAreaDomain?: string | null;
  baseTargets: GatewayStatusTarget[];
  remotePort: number;
  sshTarget: string | null;
  sshIdentity: string | null;
  loadSshTunnelModule: () => Promise<typeof import("../../infra/ssh-tunnel.js")>;
  localTlsFingerprint?: string;
}): Promise<{
  discovery: GatewayBonjourBeacon[];
  probed: GatewayStatusProbedTarget[];
  sshTarget: string | null;
  sshTunnelStarted: boolean;
  sshTunnelError: string | null;
}> {
  const discoveryPromise = discoverGatewayBeacons({
    timeoutMs: params.discoveryTimeoutMs,
    wideAreaDomain: params.wideAreaDomain,
  });

  let sshTarget = params.sshTarget;
  let sshTunnelError: string | null = null;
  let sshTunnelStarted = false;

  const tryStartTunnel = async () => {
    if (!sshTarget) {
      return null;
    }
    try {
      const { startSshPortForward } = await params.loadSshTunnelModule();
      const tunnel = await startSshPortForward({
        target: sshTarget,
        identity: params.sshIdentity ?? undefined,
        localPortPreferred: params.remotePort,
        remotePort: params.remotePort,
        timeoutMs: Math.min(1500, params.overallTimeoutMs),
      });
      sshTunnelStarted = true;
      return tunnel;
    } catch (err) {
      sshTunnelError = formatErrorMessage(err);
      return null;
    }
  };

  const discoveryTask = discoveryPromise.catch(() => []);
  const tunnelTask = sshTarget ? tryStartTunnel() : Promise.resolve(null);
  const [discovery, tunnelFirst] = await Promise.all([discoveryTask, tunnelTask]);

  if (!sshTarget && params.opts.sshAuto) {
    const { parseSshTarget } = await params.loadSshTunnelModule();
    sshTarget = pickAutoSshTargetFromDiscovery({
      discovery,
      parseSshTarget,
      sshUser: normalizeOptionalString(process.env.USER) ?? "",
    });
  }

  const tunnel =
    tunnelFirst ||
    (sshTarget && !sshTunnelStarted && !sshTunnelError ? await tryStartTunnel() : null);

  const tunnelTarget: GatewayStatusTarget | null = tunnel
    ? {
        id: "sshTunnel",
        kind: "sshTunnel",
        url: `ws://127.0.0.1:${tunnel.localPort}`,
        active: true,
        tunnel: {
          kind: "ssh",
          target: sshTarget ?? "",
          localPort: tunnel.localPort,
          remotePort: params.remotePort,
          pid: tunnel.pid,
        },
      }
    : null;

  const targets: GatewayStatusTarget[] = tunnelTarget
    ? [tunnelTarget, ...params.baseTargets.filter((target) => target.url !== tunnelTarget.url)]
    : params.baseTargets;

  try {
    const probed = await Promise.all(
      targets.map(async (target) => {
        const authResolution = await resolveAuthForTarget(params.cfg, target, {
          token: readStringValue(params.opts.token),
          password: readStringValue(params.opts.password),
        });
        const probe = await probeGateway({
          url: target.url,
          auth: {
            token: authResolution.token,
            password: authResolution.password,
          },
          tlsFingerprint:
            target.kind === "localLoopback" && target.url.startsWith("wss://")
              ? params.localTlsFingerprint
              : undefined,
          preauthHandshakeTimeoutMs: params.cfg.gateway?.handshakeTimeoutMs,
          timeoutMs: resolveProbeBudgetMs(params.overallTimeoutMs, target),
        });
        return {
          target,
          probe,
          configSummary: probe.configSnapshot ? extractConfigSummary(probe.configSnapshot) : null,
          self: pickGatewaySelfPresence(probe.presence),
          authDiagnostics: authResolution.diagnostics ?? [],
        };
      }),
    );

    return {
      discovery,
      probed,
      sshTarget,
      sshTunnelStarted,
      sshTunnelError,
    };
  } finally {
    if (tunnel) {
      try {
        await tunnel.stop();
      } catch {
        // best-effort
      }
    }
  }
}
