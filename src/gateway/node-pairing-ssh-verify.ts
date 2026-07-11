// SSH-verified node pairing auto-approval.
// Proves a pending first-time node pairing by reading the device identity back
// over SSH from the connecting host and comparing key material. Approval binds
// to machine ownership (host key + authorized key + on-disk device identity),
// not network locality, so NAT co-tenants, other users on a shared host, and
// LAN spoofing all fall through to the manual prompt.
import net from "node:net";
import os from "node:os";
import type { GatewayNodePairingConfig } from "../config/types.gateway.js";
import { normalizeDevicePublicKeyBase64Url } from "../infra/device-identity.js";
import { isLoopbackAddress, isPrivateOrLoopbackAddress, isTrustedProxyAddress } from "./net.js";
import {
  isEligibleFreshNodePairingRequest,
  type FreshNodePairingEligibilityParams,
} from "./node-pairing-auto-approve.js";
import {
  runNodeIdentityProbe,
  type NodeIdentityProbeParams,
  type NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";

// Object form of the sshVerify config, derived from the config field so this
// module adds no new public config export to the plugin-SDK surface.
type SshVerifyConfigObject = Exclude<NonNullable<GatewayNodePairingConfig["sshVerify"]>, boolean>;

export type NodePairingSshVerifyPolicy = {
  user: string;
  identity?: string;
  timeoutMs: number;
  cidrs?: string[];
};

export type NodePairingSshVerifyPlan = {
  policy: NodePairingSshVerifyPolicy;
  /** Normalized SSH target address (IPv4-mapped prefixes stripped). */
  host: string;
};

export type NodePairingSshVerifyOutcome =
  | { ok: true; user: string; host: string }
  | { ok: false; reason: "probe-failed" | "identity-unreadable" | "identity-mismatch" };

type NodeIdentityProbe = (params: NodeIdentityProbeParams) => Promise<NodeIdentityProbeResult>;

const DEFAULT_TIMEOUT_MS = 7_000;
const FAILURE_COOLDOWN_MS = 60_000;
// A host that answered with a different key is a definitive negative (and a
// possible impersonation attempt); keep it off the probe path for longer.
const MISMATCH_COOLDOWN_MS = 5 * 60_000;
const MAX_CONCURRENT_PROBES = 4;
const MAX_COOLDOWN_ENTRIES = 512;

function resolveProcessUser(): string | undefined {
  try {
    const user = os.userInfo().username.trim();
    if (user) {
      return user;
    }
  } catch {
    // Fall through to env-based resolution below.
  }
  const envUser = (process.env.USER ?? process.env.USERNAME)?.trim();
  return envUser || undefined;
}

/** Normalize the enabled-by-default config union into a probe policy, or null when off. */
export function resolveNodePairingSshVerifyPolicy(
  raw: boolean | SshVerifyConfigObject | undefined,
): NodePairingSshVerifyPolicy | null {
  if (raw === false) {
    return null;
  }
  const cfg = typeof raw === "object" && raw !== null ? raw : {};
  const user = cfg.user?.trim() || resolveProcessUser();
  if (!user) {
    return null;
  }
  const cidrs = cfg.cidrs?.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return {
    user,
    identity: cfg.identity?.trim() || undefined,
    timeoutMs:
      typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    cidrs: cidrs && cidrs.length > 0 ? cidrs : undefined,
  };
}

function normalizeProbeHost(reportedClientIp: string): string | null {
  const trimmed = reportedClientIp.trim();
  const host = trimmed.toLowerCase().startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  // Zone-scoped IPv6 literals (fe80::1%en0) are not portable SSH targets.
  if (host.includes("%") || net.isIP(host) === 0) {
    return null;
  }
  return host;
}

/**
 * Resolve whether this pairing request qualifies for an SSH verification probe.
 * Shares the fresh-node eligibility floor with trusted-CIDR auto-approval and
 * additionally bounds the probe target: default private/CGNAT ranges only, so
 * a token holder cannot use the gateway as an SSH probe primitive against
 * arbitrary public addresses.
 */
export function planNodePairingSshVerify(params: {
  config: boolean | SshVerifyConfigObject | undefined;
  eligibility: FreshNodePairingEligibilityParams;
}): NodePairingSshVerifyPlan | null {
  const policy = resolveNodePairingSshVerifyPolicy(params.config);
  if (!policy) {
    return null;
  }
  if (
    !isEligibleFreshNodePairingRequest(params.eligibility) ||
    !params.eligibility.reportedClientIp
  ) {
    return null;
  }
  // Loopback is excluded from the default scope: same-host nodes already pair
  // silently, and an SSH probe back to the gateway itself proves nothing.
  const inProbeScope = policy.cidrs
    ? isTrustedProxyAddress(params.eligibility.reportedClientIp, policy.cidrs)
    : isPrivateOrLoopbackAddress(params.eligibility.reportedClientIp) &&
      !isLoopbackAddress(params.eligibility.reportedClientIp);
  if (!inProbeScope) {
    return null;
  }
  const host = normalizeProbeHost(params.eligibility.reportedClientIp);
  return host ? { policy, host } : null;
}

type ParsedRemoteIdentity = { deviceId: string; publicKey: string };

// `sh -l` may print profile/motd noise around the JSON payload; scan for the
// first line that parses into the expected identity shape.
function parseRemoteIdentity(stdout: string): ParsedRemoteIdentity | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { deviceId?: unknown; publicKey?: unknown };
      if (typeof parsed.deviceId === "string" && typeof parsed.publicKey === "string") {
        return { deviceId: parsed.deviceId.trim(), publicKey: parsed.publicKey.trim() };
      }
    } catch {
      // Not the identity line; keep scanning.
    }
  }
  return null;
}

// Probe bookkeeping is process-local and bounded: single-flight per
// host+device, short cooldown after failures so reconnect loops do not
// re-probe every few seconds, and a small global concurrency cap so a token
// holder cannot fan out SSH probes through the gateway.
const inFlightByKey = new Map<string, Promise<NodePairingSshVerifyOutcome>>();
const cooldownExpiryByKey = new Map<string, number>();

function probeKey(host: string, deviceId: string): string {
  return `${host}\0${deviceId}`;
}

function pruneCooldowns(nowMs: number) {
  for (const [key, expiry] of cooldownExpiryByKey) {
    if (expiry <= nowMs) {
      cooldownExpiryByKey.delete(key);
    }
  }
  while (cooldownExpiryByKey.size > MAX_COOLDOWN_ENTRIES) {
    const oldest = cooldownExpiryByKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cooldownExpiryByKey.delete(oldest);
  }
}

/** Test-only reset for the process-local probe bookkeeping. */
export function resetNodePairingSshVerifyStateForTests() {
  inFlightByKey.clear();
  cooldownExpiryByKey.clear();
}

/**
 * Start an SSH verification for one pending pairing request. Returns null when
 * the probe should not run right now (cooldown or concurrency cap) so callers
 * keep the default manual-approval reconnect behavior. A reconnect that lands
 * while the probe is still running gets `alreadyInFlight: true`: the client
 * must keep its retry hint, but only the connection that started the probe
 * owns the approval work.
 */
export function startNodePairingSshVerify(params: {
  plan: NodePairingSshVerifyPlan;
  expectedDeviceId: string;
  expectedPublicKey: string;
  probe?: NodeIdentityProbe;
  nowMs?: number;
}): { done: Promise<NodePairingSshVerifyOutcome>; alreadyInFlight: boolean } | null {
  const nowMs = params.nowMs ?? Date.now();
  pruneCooldowns(nowMs);
  const key = probeKey(params.plan.host, params.expectedDeviceId);
  const inFlight = inFlightByKey.get(key);
  if (inFlight) {
    return { done: inFlight, alreadyInFlight: true };
  }
  if ((cooldownExpiryByKey.get(key) ?? 0) > nowMs) {
    return null;
  }
  if (inFlightByKey.size >= MAX_CONCURRENT_PROBES) {
    return null;
  }

  const probe = params.probe ?? runNodeIdentityProbe;
  const done = (async (): Promise<NodePairingSshVerifyOutcome> => {
    const result = await probe({
      user: params.plan.policy.user,
      host: params.plan.host,
      identity: params.plan.policy.identity,
      timeoutMs: params.plan.policy.timeoutMs,
    });
    if (result.status !== "ok") {
      cooldownExpiryByKey.set(key, Date.now() + FAILURE_COOLDOWN_MS);
      return { ok: false, reason: "probe-failed" };
    }
    const remote = parseRemoteIdentity(result.stdout);
    if (!remote) {
      cooldownExpiryByKey.set(key, Date.now() + FAILURE_COOLDOWN_MS);
      return { ok: false, reason: "identity-unreadable" };
    }
    const expectedKey = normalizeDevicePublicKeyBase64Url(params.expectedPublicKey);
    const remoteKey = normalizeDevicePublicKeyBase64Url(remote.publicKey);
    const matches =
      Boolean(expectedKey) &&
      expectedKey === remoteKey &&
      remote.deviceId === params.expectedDeviceId;
    if (!matches) {
      cooldownExpiryByKey.set(key, Date.now() + MISMATCH_COOLDOWN_MS);
      return { ok: false, reason: "identity-mismatch" };
    }
    return { ok: true, user: params.plan.policy.user, host: params.plan.host };
  })();

  const tracked = done.finally(() => {
    inFlightByKey.delete(key);
  });
  inFlightByKey.set(key, tracked);
  return { done: tracked, alreadyInFlight: false };
}
