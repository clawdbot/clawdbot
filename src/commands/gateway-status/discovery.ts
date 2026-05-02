import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import {
  buildGatewayDiscoveryTarget,
  serializeGatewayDiscoveryBeacon,
} from "../../infra/gateway-discovery-targets.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function inferSshTargetFromRemoteUrl(rawUrl?: string | null): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = normalizeOptionalString(rawUrl) ?? "";
  if (!trimmed) {
    return null;
  }
  let host: string | null = null;
  try {
    host = new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
  if (!host) {
    return null;
  }
  const user = normalizeOptionalString(process.env.USER) ?? "";
  return user ? `${user}@${host}` : host;
}

function buildSshTarget(input: { user?: string; host?: string; port?: number }): string | null {
  const host = normalizeOptionalString(input.host) ?? "";
  if (!host) {
    return null;
  }
  const user = normalizeOptionalString(input.user) ?? "";
  const base = user ? `${user}@${host}` : host;
  const port = input.port ?? 22;
  if (port && port !== 22) {
    return `${base}:${port}`;
  }
  return base;
}

export async function resolveSshTarget(params: {
  rawTarget: string;
  identity: string | null;
  overallTimeoutMs: number;
  loadSshConfigModule: () => Promise<typeof import("../../infra/ssh-config.js")>;
  loadSshTunnelModule: () => Promise<typeof import("../../infra/ssh-tunnel.js")>;
}): Promise<{ target: string; identity?: string } | null> {
  const [{ resolveSshConfig }, { parseSshTarget }] = await Promise.all([
    params.loadSshConfigModule(),
    params.loadSshTunnelModule(),
  ]);
  const parsed = parseSshTarget(params.rawTarget);
  if (!parsed) {
    return null;
  }
  const config = await resolveSshConfig(parsed, {
    identity: params.identity ?? undefined,
    timeoutMs: Math.min(800, params.overallTimeoutMs),
  });
  if (!config) {
    return { target: params.rawTarget, identity: params.identity ?? undefined };
  }
  const target = buildSshTarget({
    user: config.user ?? parsed.user,
    host: config.host ?? parsed.host,
    port: config.port ?? parsed.port,
  });
  if (!target) {
    return { target: params.rawTarget, identity: params.identity ?? undefined };
  }
  const identityFile =
    params.identity ??
    config.identityFiles.find((entry) => normalizeOptionalString(entry)) ??
    undefined;
  return { target, identity: identityFile };
}

export function pickAutoSshTargetFromDiscovery(params: {
  discovery: GatewayBonjourBeacon[];
  parseSshTarget: (target: string) => unknown;
  sshUser?: string | null;
}): string | null {
  for (const beacon of params.discovery) {
    const sshTarget = buildGatewayDiscoveryTarget(beacon, {
      sshUser: params.sshUser ?? undefined,
    }).sshTarget;
    if (!sshTarget) {
      continue;
    }
    if (params.parseSshTarget(sshTarget)) {
      return sshTarget;
    }
  }
  return null;
}

export { serializeGatewayDiscoveryBeacon };
