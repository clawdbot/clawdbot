// Generates setup codes used to pair external channels with OpenClaw.
import os from "node:os";
import {
  isCarrierGradeNatIpv4Address,
  isIpv4Address,
  isIpv6Address,
  isLoopbackIpAddress,
  isRfc1918Ipv4Address,
  parseCanonicalIpAddress,
} from "@openclaw/net-policy/ip";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { materializeGatewayAuthSecretRefs } from "../gateway/auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { normalizeWebSocketProtocol } from "../gateway/websocket-protocol.js";
import { resolveAdvertisedLanHostCore } from "../infra/advertised-lan-host.js";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import {
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
} from "../infra/network-interfaces.js";
import {
  deviceBootstrapProfilesEqual,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  resolvePairingSetupAccess,
  type DeviceBootstrapProfileInput,
  type PairingSetupAccess,
} from "../shared/device-bootstrap-profile.js";
import { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
import {
  resolveTailnetHostWithRunner,
  resolveTailscalePublishedHost,
} from "../shared/tailscale-status.js";

type PairingSetupPayload = {
  url: string;
  urls?: string[];
  bootstrapToken: string;
  expiresAtMs?: number;
  tlsFingerprint?: string;
};

const PAIRING_SETUP_MAX_URLS = 8;

type PairingSetupCommandResult = {
  code: number | null;
  stdout: string;
  stderr?: string;
};

type PairingSetupCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; maxOutputBytes?: number },
) => Promise<PairingSetupCommandResult>;

type ResolvePairingSetupOptions = {
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  bootstrapProfile?: DeviceBootstrapProfileInput;
  issuedBootstrap?: { token: string; expiresAtMs: number; setupId: string };
  pairingBaseDir?: string;
  runCommandWithTimeout?: PairingSetupCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
  localTlsFingerprint?: string;
  loadLocalTlsFingerprint?: () => Promise<string | undefined>;
};

export function resolveConfiguredPairingPublicUrl(config: OpenClawConfig): string | undefined {
  const value = config.plugins?.entries?.["device-pair"]?.config?.["publicUrl"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type PairingSetupResolution =
  | {
      ok: true;
      payload: PairingSetupPayload;
      authLabel: "token" | "password";
      urlSource: string;
      access: PairingSetupAccess;
      accessDowngraded: boolean;
      setupId: string;
      expiresAtMs: number;
    }
  | {
      ok: false;
      error: string;
    };

type ResolveUrlResult = {
  url?: string;
  source?: string;
  error?: string;
};

function describeSecureMobilePairingFix(source?: string): string {
  const sourceNote = source ? ` Resolved source: ${source}.` : "";
  return (
    "Tailscale and public mobile pairing require a secure gateway URL (wss://) or Tailscale Serve/Funnel." +
    sourceNote +
    " Fix: use a private LAN address, prefer gateway.tailscale.mode=serve, or set " +
    "gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. " +
    "ws:// is only valid for localhost, private LAN addresses, .local hosts, or the Android emulator."
  );
}

function normalizeMobilePairingHost(host: string): string {
  let normalized = normalizeLowercaseStringOrEmpty(host);
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }
  return normalized;
}

function isPrivateLanHost(host: string): boolean {
  const normalized = normalizeMobilePairingHost(host);
  if (normalized.endsWith(".local")) {
    return true;
  }
  if (isRfc1918Ipv4Address(normalized)) {
    return true;
  }
  const parsed = parseCanonicalIpAddress(normalized);
  if (!parsed) {
    return false;
  }
  if (isIpv4Address(parsed)) {
    const normalizedIp = parsed.toString();
    return normalizedIp.startsWith("169.254.") && !isCarrierGradeNatIpv4Address(normalizedIp);
  }
  if (!isIpv6Address(parsed)) {
    return false;
  }
  const normalizedIp = normalizeLowercaseStringOrEmpty(parsed.toString());
  return (
    normalizedIp.startsWith("fe80:") ||
    normalizedIp.startsWith("fc") ||
    normalizedIp.startsWith("fd")
  );
}

function isMobilePairingCleartextAllowedHost(host: string): boolean {
  const normalized = normalizeMobilePairingHost(host);
  return (
    normalized === "localhost" ||
    isLoopbackIpAddress(normalized) ||
    normalized === "10.0.2.2" ||
    isPrivateLanHost(normalized)
  );
}

function isFullAccessMobilePairingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:") {
      return true;
    }
    const host = normalizeMobilePairingHost(parsed.hostname);
    return parsed.protocol === "ws:" && (host === "localhost" || isLoopbackIpAddress(host));
  } catch {
    return false;
  }
}

function validateMobilePairingUrl(url: string, source?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Resolved mobile pairing URL is invalid.";
  }
  const protocol = normalizeWebSocketProtocol(parsed.protocol);
  if (protocol === "wss:") {
    return null;
  }
  if (protocol !== "ws:" || isMobilePairingCleartextAllowedHost(parsed.hostname)) {
    return null;
  }
  return describeSecureMobilePairingFix(source);
}

type ResolveAuthLabelResult = {
  label?: "token" | "password";
  error?: string;
};

const GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE = /^(?:https?|wss?):(?!\/\/)/i;
const SCHEME_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\//;

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (GATEWAY_SCHEME_WITHOUT_AUTHORITY_RE.test(trimmed)) {
    return null;
  }
  const parsedUrl = parseNormalizedGatewayUrl(trimmed);
  if (parsedUrl) {
    return parsedUrl;
  }
  if (trimmed.includes("://") || SCHEME_LIKE_PATH_RE.test(trimmed)) {
    return null;
  }
  const withoutPath = normalizeOptionalString(trimmed.split("/", 1)[0]) ?? "";
  return withoutPath ? parseNormalizedGatewayUrl(`${schemeFallback}://${withoutPath}`) : null;
}

function parseNormalizedGatewayUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      return null;
    }
    const protocol = normalizeWebSocketProtocol(parsed.protocol);
    if (!protocol) {
      return null;
    }
    const resolvedScheme = protocol.replace(":", "");
    if (resolvedScheme !== "ws" && resolvedScheme !== "wss") {
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      return null;
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    const contextPath = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${resolvedScheme}://${host}${port}${contextPath}`;
  } catch {
    return null;
  }
}

function resolveScheme(
  cfg: OpenClawConfig,
  opts?: {
    forceSecure?: boolean;
  },
): "ws" | "wss" {
  if (opts?.forceSecure) {
    return "wss";
  }
  return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function isTailnetIPv4(address: string): boolean {
  return isCarrierGradeNatIpv4Address(address);
}

function pickIPv4Matching(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
  matches: (address: string) => boolean,
): string | null {
  return (
    pickMatchingExternalInterfaceAddress(safeNetworkInterfaces(networkInterfaces), {
      family: "IPv4",
      matches,
    }) ?? null
  );
}

function pickTailnetIPv4(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
): string | null {
  return pickIPv4Matching(networkInterfaces, isTailnetIPv4);
}

function resolvePairingSetupAuthLabel(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): ResolveAuthLabelResult {
  const mode = cfg.gateway?.auth?.mode;
  const defaults = cfg.secrets?.defaults;
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults,
  }).ref;
  const passwordRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.password,
    defaults,
  }).ref;
  const envToken = normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD);
  const token =
    envToken || (tokenRef ? undefined : normalizeSecretInputString(cfg.gateway?.auth?.token));
  const password =
    envPassword ||
    (passwordRef ? undefined : normalizeSecretInputString(cfg.gateway?.auth?.password));

  if (mode === "password") {
    if (!password) {
      return { error: "Gateway auth is set to password, but no password is configured." };
    }
    return { label: "password" };
  }
  if (mode === "token") {
    if (!token) {
      return { error: "Gateway auth is set to token, but no token is configured." };
    }
    return { label: "token" };
  }
  if (token) {
    return { label: "token" };
  }
  if (password) {
    return { label: "password" };
  }
  return { error: "Gateway auth is not configured (no token or password)." };
}

async function resolveGatewayUrl(
  cfg: OpenClawConfig,
  opts: {
    env: NodeJS.ProcessEnv;
    publicUrl?: string;
    preferRemoteUrl?: boolean;
    forceSecure?: boolean;
    runCommandWithTimeout?: PairingSetupCommandRunner;
    networkInterfaces: () => ReturnType<typeof os.networkInterfaces>;
  },
): Promise<ResolveUrlResult> {
  const scheme = resolveScheme(cfg, { forceSecure: opts.forceSecure });
  const port = resolveGatewayPort(cfg, opts.env);

  if (typeof opts.publicUrl === "string" && opts.publicUrl.trim()) {
    const url = normalizeUrl(opts.publicUrl, scheme);
    if (url) {
      return { url, source: "plugins.entries.device-pair.config.publicUrl" };
    }
    return { error: "Configured publicUrl is invalid." };
  }

  const remoteUrlRaw = cfg.gateway?.remote?.url;
  const hasRemoteUrl = typeof remoteUrlRaw === "string" && remoteUrlRaw.trim();
  const remoteUrl = hasRemoteUrl ? normalizeUrl(remoteUrlRaw, scheme) : null;
  if (hasRemoteUrl && !remoteUrl) {
    return { error: "Configured gateway.remote.url is invalid." };
  }
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    const publishedHost = resolveTailscalePublishedHost({
      tailscaleMode,
      tailnetHost: host,
    });
    return { url: `wss://${publishedHost}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const advertisedLanHost =
    cfg.gateway?.bind === "lan"
      ? await resolveAdvertisedLanHostCore({
          networkInterfaces: opts.networkInterfaces,
          runCommandWithTimeout: opts.runCommandWithTimeout,
        })
      : null;
  const bindResult = resolveGatewayBindUrl({
    bind: cfg.gateway?.bind,
    customBindHost: cfg.gateway?.customBindHost,
    scheme,
    port,
    pickTailnetHost: () => pickTailnetIPv4(opts.networkInterfaces),
    pickLanHost: () => advertisedLanHost,
  });
  if (bindResult) {
    return bindResult;
  }

  return {
    error:
      "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
  };
}

export function encodePairingSetupCode(payload: PairingSetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const PAIRING_SETUP_URL_PREFIX = "oc-pair://";
const PAIRING_SETUP_CODE_RE = /^[A-Za-z0-9_-]+$/u;

/** Decode the current setup payload plus additive fields emitted by older pairing surfaces. */
export function decodePairingSetupCode(
  input: string,
  options: { nowMs?: number } = {},
): PairingSetupPayload {
  const trimmed = input.trim();
  const setupCode = trimmed.toLowerCase().startsWith(PAIRING_SETUP_URL_PREFIX)
    ? trimmed.slice(PAIRING_SETUP_URL_PREFIX.length)
    : trimmed;
  if (!setupCode || !PAIRING_SETUP_CODE_RE.test(setupCode)) {
    throw new Error("Invalid pairing setup code or URL.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid pairing setup code or URL.");
  }
  if (!isRecord(decoded)) {
    throw new Error("Invalid pairing setup payload.");
  }

  const url = normalizeOptionalString(decoded.url);
  const bootstrapToken = normalizeOptionalString(decoded.bootstrapToken);
  if (!url || !bootstrapToken || normalizeUrl(url, "ws") !== url) {
    throw new Error("Invalid pairing setup payload.");
  }

  let urls: string[] | undefined;
  if (decoded.urls !== undefined) {
    if (
      !Array.isArray(decoded.urls) ||
      decoded.urls.length === 0 ||
      decoded.urls.length > PAIRING_SETUP_MAX_URLS ||
      decoded.urls.some(
        (candidate) => typeof candidate !== "string" || normalizeUrl(candidate, "ws") !== candidate,
      )
    ) {
      throw new Error("Invalid pairing setup payload.");
    }
    urls = decoded.urls;
  }

  let expiresAtMs: number | undefined;
  if (decoded.expiresAtMs !== undefined) {
    const candidate = decoded.expiresAtMs;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error("Invalid pairing setup payload.");
    }
    expiresAtMs = candidate;
    if (candidate <= (options.nowMs ?? Date.now())) {
      throw new Error("Pairing setup code has expired.");
    }
  }

  const tlsFingerprint =
    typeof decoded.tlsFingerprint === "string"
      ? normalizeTlsFingerprint(decoded.tlsFingerprint)
      : undefined;
  if (decoded.tlsFingerprint !== undefined && !tlsFingerprint) {
    throw new Error("Invalid pairing setup payload.");
  }

  return {
    url,
    ...(urls ? { urls } : {}),
    bootstrapToken,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
  };
}

export async function resolvePairingSetupFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupOptions = {},
): Promise<PairingSetupResolution> {
  assertExplicitGatewayAuthModeWhenBothConfigured(cfg);
  const env = options.env ?? process.env;
  const cfgForAuth = await materializeGatewayAuthSecretRefs({
    cfg,
    env,
    mode: cfg.gateway?.auth?.mode,
    hasTokenOverride: false,
    hasPasswordOverride: false,
    hasTokenFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
    hasPasswordFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
  });
  const authLabel = resolvePairingSetupAuthLabel(cfgForAuth, env);
  if (authLabel.error) {
    return { ok: false, error: authLabel.error };
  }
  const urlResult = await resolveGatewayUrl(cfgForAuth, {
    env,
    publicUrl: options.publicUrl,
    preferRemoteUrl: options.preferRemoteUrl,
    forceSecure: options.forceSecure,
    runCommandWithTimeout: options.runCommandWithTimeout,
    networkInterfaces: options.networkInterfaces ?? os.networkInterfaces,
  });

  if (!urlResult.url) {
    return { ok: false, error: urlResult.error ?? "Gateway URL unavailable." };
  }
  const mobilePairingUrlError = validateMobilePairingUrl(urlResult.url, urlResult.source);
  if (mobilePairingUrlError) {
    return { ok: false, error: mobilePairingUrlError };
  }

  if (!authLabel.label) {
    return { ok: false, error: "Gateway auth is not configured (no token or password)." };
  }

  const uniqueUrls = [urlResult.url];
  const requestedBootstrapProfile =
    options.bootstrapProfile ?? FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE;
  const accessDowngraded =
    deviceBootstrapProfilesEqual(
      requestedBootstrapProfile,
      FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    ) && uniqueUrls.some((url) => !isFullAccessMobilePairingUrl(url));
  // Every advertised URL shares this bearer token. Keep plaintext LAN routes
  // useful for node/chat access, but reserve admin handoff for an all-TLS
  // route set (or same-host loopback, where no LAN observer exists).
  const issuedBootstrapProfile = accessDowngraded
    ? PAIRING_SETUP_BOOTSTRAP_PROFILE
    : requestedBootstrapProfile;
  const directGatewayTlsFingerprintRaw =
    urlResult.url.startsWith("wss://") && urlResult.source?.startsWith("gateway.bind=")
      ? (options.localTlsFingerprint ?? (await options.loadLocalTlsFingerprint?.()))
      : urlResult.url.startsWith("wss://") && urlResult.source === "gateway.remote.url"
        ? cfgForAuth.gateway?.remote?.tlsFingerprint
        : undefined;
  const directGatewayTlsFingerprint = directGatewayTlsFingerprintRaw
    ? normalizeTlsFingerprint(directGatewayTlsFingerprintRaw)
    : undefined;
  if (directGatewayTlsFingerprintRaw !== undefined && !directGatewayTlsFingerprint) {
    return { ok: false, error: "Gateway TLS fingerprint is invalid." };
  }
  const issued =
    options.issuedBootstrap ??
    (await issueDevicePairSetupBootstrapToken({
      baseDir: options.pairingBaseDir,
      profile: issuedBootstrapProfile,
    }));

  return {
    ok: true,
    payload: {
      url: urlResult.url,
      ...(uniqueUrls.length > 1 ? { urls: uniqueUrls } : {}),
      bootstrapToken: issued.token,
      expiresAtMs: issued.expiresAtMs,
      ...(directGatewayTlsFingerprint ? { tlsFingerprint: directGatewayTlsFingerprint } : {}),
    },
    authLabel: authLabel.label,
    urlSource: urlResult.source ?? "unknown",
    access: resolvePairingSetupAccess(issuedBootstrapProfile),
    accessDowngraded,
    setupId: issued.setupId,
    expiresAtMs: issued.expiresAtMs,
  };
}
