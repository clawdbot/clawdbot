/** Shared helpers for gateway status target selection, auth, summaries, and probe rendering. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../../config/types.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { resolveGatewayProbeSurfaceAuth } from "../../gateway/auth-surface-resolution.js";
import { isLoopbackHost } from "../../gateway/net.js";
import type { GatewayProbeCapability, GatewayProbeResult } from "../../gateway/probe.js";
import { inspectBestEffortPrimaryTailnetIPv4 } from "../../infra/network-discovery-display.js";
import { parseStrictInteger } from "../../infra/parse-finite-number.js";

const MISSING_SCOPE_PATTERN = /\bmissing scope:\s*[a-z0-9._-]+/i;

type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";

/** Concrete websocket endpoint that gateway status should probe. */
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

/** Sanitized config subset rendered by the deep gateway status view. */
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
  return parseStrictInteger(s) ?? null;
}

/** Parses CLI timeout input with the gateway-status fallback rules. */
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

/** Builds the deduplicated ordered gateway probe targets from CLI input and config. */
export function resolveTargets(
  cfg: OpenClawConfig,
  explicitUrl?: string,
  localPortOverride?: number,
): GatewayStatusTarget[] {
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

  const port = localPortOverride ?? resolveGatewayPort(cfg);
  const localScheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  const localLoopbackTarget: GatewayStatusTarget = {
    id: "localLoopback",
    kind: "localLoopback",
    url: `${localScheme}://127.0.0.1:${port}`,
    active: localPortOverride !== undefined || cfg.gateway?.mode !== "remote",
  };
  if (localPortOverride !== undefined && !explicit) {
    add(localLoopbackTarget);
    return targets;
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

  add(localLoopbackTarget);

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
  if (target.active) {
    return overallMs;
  }
  if (target.kind === "localLoopback") {
    return Math.min(800, overallMs);
  }
  if (!isLoopbackProbeTarget(target)) {
    return Math.min(1500, overallMs);
  }
  return overallMs;
}

/** Normalizes user-entered SSH targets, accepting both raw targets and `ssh host` input. */
export function sanitizeSshTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^ssh\s+/, "");
}

/** Resolves auth for the probe surface represented by the selected status target. */
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

  const resolved = await resolveGatewayProbeSurfaceAuth({
    config: cfg,
    surface: target.kind === "configRemote" || target.kind === "sshTunnel" ? "remote" : "local",
  });
  return {
    token: resolved.token,
    password: resolved.password,
    ...(resolved.diagnostics ? { diagnostics: resolved.diagnostics } : {}),
  };
}

/** Extracts the config fields displayed by `openclaw gateway status --deep`. */
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

/** Builds local and tailnet gateway URL hints for the selected gateway port. */
export function buildNetworkHints(cfg: OpenClawConfig, localPortOverride?: number) {
  const { tailnetIPv4 } = inspectBestEffortPrimaryTailnetIPv4();
  const port = localPortOverride ?? resolveGatewayPort(cfg);
  const localScheme = cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
  return {
    localLoopbackUrl: `${localScheme}://127.0.0.1:${port}`,
    localTailnetUrl: tailnetIPv4 ? `${localScheme}://${tailnetIPv4}:${port}` : null,
    tailnetIPv4: tailnetIPv4 ?? null,
  };
}

/** Renders the status heading for a single gateway probe target. */
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

/** Returns true when auth succeeded enough to connect but lacks the read scope. */
export function isScopeLimitedProbeFailure(probe: GatewayProbeResult): boolean {
  if (probe.ok || probe.connectLatencyMs == null) {
    return false;
  }
  return MISSING_SCOPE_PATTERN.test(probe.error ?? "");
}

/** Returns true when the gateway connection was established but a later probe failed. */
export function isPostConnectProbeFailure(probe: GatewayProbeResult): boolean {
  return !probe.ok && probe.connectLatencyMs != null;
}

/** Returns true when the probe established any gateway connection. */
export function isProbeReachable(probe: GatewayProbeResult): boolean {
  return probe.ok || probe.connectLatencyMs != null;
}

function getGatewayProbeCapability(probe: GatewayProbeResult): GatewayProbeCapability {
  return probe.auth.capability;
}

export function summarizeGatewayProbeCapability(
  probes: GatewayProbeResult[],
): GatewayProbeCapability {
  // Show the strongest observed capability across all attempted targets.
  const priority: GatewayProbeCapability[] = [
    "admin_capable",
    "write_capable",
    "read_only",
    "connected_no_operator_scope",
    "pairing_pending",
    "unknown",
  ];
  for (const capability of priority) {
    if (probes.some((probe) => getGatewayProbeCapability(probe) === capability)) {
      return capability;
    }
  }
  return "unknown";
}

function formatGatewayProbeCapabilityLabel(capability: GatewayProbeCapability) {
  switch (capability) {
    case "admin_capable":
      return "Capability: admin-capable";
    case "write_capable":
      return "Capability: write-capable";
    case "read_only":
      return "Capability: read-only";
    case "connected_no_operator_scope":
      return "Capability: connect-only";
    case "pairing_pending":
      return "Capability: pairing pending";
    default:
      return "Capability: unknown";
  }
}

function colorForGatewayProbeCapability(capability: GatewayProbeCapability) {
  switch (capability) {
    case "admin_capable":
    case "write_capable":
    case "read_only":
      return theme.info;
    case "connected_no_operator_scope":
    case "pairing_pending":
      return theme.warn;
    default:
      return theme.muted;
  }
}

function renderProbeCapabilityLine(probe: GatewayProbeResult, rich: boolean) {
  const capability = getGatewayProbeCapability(probe);
  return colorize(
    rich,
    colorForGatewayProbeCapability(capability),
    formatGatewayProbeCapabilityLabel(capability),
  );
}

export function renderProbeSummaryLine(probe: GatewayProbeResult, rich: boolean) {
  const capability = renderProbeCapabilityLine(probe, rich);
  if (probe.ok) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${capability} · ${colorize(rich, theme.success, "Read probe: ok")}`;
  }

  const detail = probe.error ? ` - ${probe.error}` : "";
  if (probe.connectLatencyMs != null) {
    const latency =
      typeof probe.connectLatencyMs === "number" ? `${probe.connectLatencyMs}ms` : "unknown";
    const readStatus = isScopeLimitedProbeFailure(probe)
      ? colorize(rich, theme.warn, "Read probe: limited")
      : colorize(rich, theme.error, "Read probe: failed");
    return `${colorize(rich, theme.success, "Connect: ok")} (${latency}) · ${capability} · ${readStatus}${detail}`;
  }

  if (getGatewayProbeCapability(probe) === "pairing_pending") {
    return `${colorize(rich, theme.warn, "Connect: blocked")}${detail} · ${capability}`;
  }

  return `${colorize(rich, theme.error, "Connect: failed")}${detail} · ${capability}`;
}
