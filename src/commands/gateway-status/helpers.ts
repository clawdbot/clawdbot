import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveGatewayProbeSurfaceAuth } from "../../gateway/auth-surface-resolution.js";
import { isLoopbackHost } from "../../gateway/net.js";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { inspectBestEffortPrimaryTailnetIPv4 } from "../../infra/network-discovery-display.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { colorize, theme } from "../../terminal/theme.js";
import { pickGatewaySelfPresence } from "../gateway-presence.js";

const MISSING_SCOPE_PATTERN = /\bmissing scope:\s*[a-z0-9._-]+/i;

type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";

export type GatewayStatusTarget = {
  id: string;
  kind: TargetKind;
  url: string;
  active: boolean;
  tunnel?: {
    kind: "ssh";
    target: string;
    localPort: number;
    remotePort: number;
    pid: number | null;
  };
};

export type GatewayConfigSummary = {
  path: string | null;
  exists: boolean;
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
  legacyIssues: Array<{ path: string; message: string }>;
  gateway: {
    mode: string | null;
    bind: string | null;
    port: number | null;
    controlUiEnabled: boolean | null;
    controlUiBasePath: string | null;
    authMode: string | null;
    authTokenConfigured: boolean;
    authPasswordConfigured: boolean;
    remoteUrl: string | null;
    remoteTokenConfigured: boolean;
    remotePasswordConfigured: boolean;
    tailscaleMode: string | null;
  };
  discovery: {
    wideAreaEnabled: boolean | null;
  };
};

function parseIntOrNull(value: unknown): number | null {
  const s =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";
  if (!s) {
    return null;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseTimeoutMs(raw: unknown, fallbackMs: number): number {
  return parseTimeoutMsWithFallback(raw, fallbackMs);
}

function normalizeWsUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
    return null;
  }
  return trimmed;
}

export function resolveTargets(cfg: OpenClawConfig, explicitUrl?: string): GatewayStatusTarget[] {
  const targets: GatewayStatusTarget[] = [];
  const add = (t: GatewayStatusTarget) => {
    if (!targets.some((x) => x.url === t.url)) {
      targets.push(t);
    }
  };

  const explicit = typeof explicitUrl === "string" ? normalizeWsUrl(explicitUrl) : null;
  if (explicit) {
    add({ id: "explicit", kind: "explicit", url: explicit, active: true });
  }

  const remoteUrl =
    typeof cfg.gateway?.remote?.url === "string" ? normalizeWsUrl(cfg.gateway.remote.url) : null;
  if (remoteUrl) {
    add({
      id: "configRemote",
      kind: "configRemote",
      url: remoteUrl,
      active: cfg.gateway?.mode === "remote",
    });
  }

  const port = resolveGatewayPort(cfg);
  const localScheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  add({
    id: "localLoopback",
    kind: "localLoopback",
    url: `${localScheme}://127.0.0.1:${port}`,
    active: cfg.gateway?.mode !== "remote",
  });

  return targets;
}

function isLoopbackProbeTarget(target: Pick<GatewayStatusTarget, "kind" | "url">): boolean {
  if (target.kind === "localLoopback") {
    return true;
  }
  try {
    return isLoopbackHost(new URL(target.url).hostname);
  } catch {
    return false;
  }
}

export function resolveProbeBudgetMs(
  overallMs: number,
  target: Pick<GatewayStatusTarget, "kind" | "active" | "url">,
): number {
  if (target.kind === "sshTunnel") {
    return Math.min(2000, overallMs);
  }
  if (!isLoopbackProbeTarget(target)) {
    return Math.min(1500, overallMs);
  }
  if (target.kind === "localLoopback" && !target.active) {
    return Math.min(800, overallMs);
  }
  // Active/discovered loopback probes and explicit loopback URLs should honor
  // the caller budget because healthy local detail RPCs can legitimately take
  // longer than the legacy short caps.
  return overallMs;
}

export function sanitizeSshTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^ssh\\s+/, "");
}

export async function resolveAuthForTarget(
  cfg: OpenClawConfig,
  target: GatewayStatusTarget,
  overrides: { token?: string; password?: string },
): Promise<{ token?: string; password?: string; diagnostics?: string[] }> {
  const tokenOverride = normalizeOptionalString(overrides.token);
  const passwordOverride = normalizeOptionalString(overrides.password);
  if (tokenOverride || passwordOverride) {
    return { token: tokenOverride, password: passwordOverride };
  }

  return resolveGatewayProbeSurfaceAuth({
    config: cfg,
    surface: target.kind === "configRemote" || target.kind === "sshTunnel" ? "remote" : "local",
  });
}

export { pickGatewaySelfPresence };

export function extractConfigSummary(snapshotUnknown: unknown): GatewayConfigSummary {
  const snap = snapshotUnknown as Partial<ConfigFileSnapshot> | null;
  const path = typeof snap?.path === "string" ? snap.path : null;
  const exists = Boolean(snap?.exists);
  const valid = Boolean(snap?.valid);
  const issuesRaw = Array.isArray(snap?.issues) ? snap.issues : [];
  const legacyRaw = Array.isArray(snap?.legacyIssues) ? snap.legacyIssues : [];

  const cfg = (snap?.config ?? {}) as Record<string, unknown>;
  const gateway = (cfg.gateway ?? {}) as Record<string, unknown>;
  const secrets = (cfg.secrets ?? {}) as Record<string, unknown>;
  const secretDefaults = (secrets.defaults ?? undefined) as
    | { env?: string; file?: string; exec?: string }
    | undefined;
  const discovery = (cfg.discovery ?? {}) as Record<string, unknown>;
  const wideArea = (discovery.wideArea ?? {}) as Record<string, unknown>;

  const remote = (gateway.remote ?? {}) as Record<string, unknown>;
  const auth = (gateway.auth ?? {}) as Record<string, unknown>;
  const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>;
  const tailscale = (gateway.tailscale ?? {}) as Record<string, unknown>;

  const authMode = typeof auth.mode === "string" ? auth.mode : null;
  const authTokenConfigured = hasConfiguredSecretInput(auth.token, secretDefaults);
  const authPasswordConfigured = hasConfiguredSecretInput(auth.password, secretDefaults);

  const remoteUrl = typeof remote.url === "string" ? normalizeWsUrl(remote.url) : null;
  const remoteTokenConfigured = hasConfiguredSecretInput(remote.token, secretDefaults);
  const remotePasswordConfigured = hasConfiguredSecretInput(remote.password, secretDefaults);

  const wideAreaEnabled = typeof wideArea.enabled === "boolean" ? wideArea.enabled : null;

  return {
    path,
    exists,
    valid,
    issues: issuesRaw
      .filter(
        (i): i is { path: string; message: string } =>
          i && typeof i.path === "string" && typeof i.message === "string",
      )
      .map((i) => ({ path: i.path, message: i.message })),
    legacyIssues: legacyRaw
      .filter(
        (i): i is { path: string; message: string } =>
          i && typeof i.path === "string" && typeof i.message === "string",
      )
      .map((i) => ({ path: i.path, message: i.message })),
    gateway: {
      mode: typeof gateway.mode === "string" ? gateway.mode : null,
      bind: typeof gateway.bind === "string" ? gateway.bind : null,
      port: parseIntOrNull(gateway.port),
      controlUiEnabled: typeof controlUi.enabled === "boolean" ? controlUi.enabled : null,
      controlUiBasePath: typeof controlUi.basePath === "string" ? controlUi.basePath : null,
      authMode,
      authTokenConfigured,
      authPasswordConfigured,
      remoteUrl,
      remoteTokenConfigured,
      remotePasswordConfigured,
      tailscaleMode: typeof tailscale.mode === "string" ? tailscale.mode : null,
    },
    discovery: { wideAreaEnabled },
  };
}

export function buildNetworkHints(cfg: OpenClawConfig) {
  const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
  const port = resolveGatewayPort(cfg);
  const localScheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  return {
    localLoopbackUrl: `${localScheme}://127.0.0.1:${port}`,
    localTailnetUrl: tailnetIPv4 ? `${localScheme}://${tailnetIPv4}:${port}` : null,
    tailnetIPv4: tailnetIPv4 ?? null,
  };
}

export function renderTargetHeader(target: GatewayStatusTarget, rich: boolean) {
  const kindLabel =
    target.kind === "localLoopback"
      ? "Local loopback"
      : target.kind === "sshTunnel"
        ? "Remote over SSH"
        : target.kind === "configRemote"
          ? target.active
            ? "Remote (configured)"
            : "Remote (configured, inactive)"
          : "URL (explicit)";
  return `${colorize(rich, theme.heading, kindLabel)} ${colorize(rich, theme.muted, target.url)}`;
}

export function isScopeLimitedProbeFailure(probe: GatewayProbeResult): boolean {
  if (probe.ok || probe.connectLatencyMs == null) {
    return false;
  }
  return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}

export function isProbeReachable(probe: GatewayProbeResult): boolean {
  return probe.ok || isScopeLimitedProbeFailure(probe);
}

export function renderProbeSummaryLine(probe: GatewayProbeResult, rich: boolean) {
  if (probe.ok) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${colorize(rich, theme.success, "RPC: ok")}`;
  }

  const detail = probe.error ? ` - ${probe.error}` : "";
  if (probe.connectLatencyMs != null) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    const rpcStatus = isScopeLimitedProbeFailure(probe)
      ? colorize(rich, theme.warn, "RPC: limited")
      : colorize(rich, theme.error, "RPC: failed");
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${rpcStatus}${detail}`;
  }

  return `${colorize(rich, theme.error, "Connect: failed")}${detail}`;
}
