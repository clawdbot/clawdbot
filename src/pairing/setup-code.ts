import os from "node:os";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { materializeGatewayAuthSecretRefs } from "../gateway/auth-config-utils.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { isLoopbackHost, isSecureWebSocketUrl } from "../gateway/net.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  pickMatchingExternalInterfaceAddress,
  safeNetworkInterfaces,
} from "../infra/network-interfaces.js";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
import {
  isCarrierGradeNatIpv4Address,
  isIpv4Address,
  isIpv6Address,
  isRfc1918Ipv4Address,
  parseCanonicalIpAddress,
} from "../shared/net/ip.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";

export type PairingSetupPayload = {
  url: string;
  bootstrapToken: string;
};

export type PairingSetupCommandResult = {
  code: number | null;
  stdout: string;
  stderr?: string;
};

export type PairingSetupCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<PairingSetupCommandResult>;

export type ResolvePairingSetupOptions = {
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  pairingBaseDir?: string;
  runCommandWithTimeout?: PairingSetupCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
};

export type PairingSetupResolution =
  | {
      ok: true;
      payload: PairingSetupPayload;
      authLabel: "token" | "password";
      urlSource: string;
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
    " Fix: use a private LAN IP address, prefer gateway.tailscale.mode=serve, or set " +
    "gateway.remote.url / plugins.entries.device-pair.config.publicUrl to a wss:// URL. " +
    "ws:// is only valid for localhost, private LAN IP addresses, or the Android emulator."
  );
}

function isPrivateLanIpHost(host: string): boolean {
  if (isRfc1918Ipv4Address(host)) {
    return true;
  }
  const parsed = parseCanonicalIpAddress(host);
  if (!parsed) {
    return false;
  }
  if (isIpv4Address(parsed)) {
    const normalized = parsed.toString();
    return normalized.startsWith("169.254.") && !isCarrierGradeNatIpv4Address(normalized);
  }
  if (!isIpv6Address(parsed)) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(parsed.toString());
  return (
    normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")
  );
}

function isMobilePairingCleartextAllowedHost(host: string): boolean {
  return isLoopbackHost(host) || host === "10.0.2.2" || isPrivateLanIpHost(host);
}

function validateMobilePairingUrl(url: string, source?: string): string | null {
  if (isSecureWebSocketUrl(url)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Resolved mobile pairing URL is invalid.";
  }
  const protocol =
    parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
  if (protocol !== "ws:" || isMobilePairingCleartextAllowedHost(parsed.hostname)) {
    return null;
  }
  return describeSecureMobilePairingFix(source);
}

type ResolveAuthLabelResult = {
  label?: "token" | "password";
  error?: string;
};

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(":", "");
    if (!scheme) {
      return null;
    }
    const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
    if (resolvedScheme !== "ws" && resolvedScheme !== "wss") {
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      return null;
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${resolvedScheme}://${host}${port}`;
  } catch {
    // Fall through to host:port parsing.
  }

  const withoutPath = trimmed.split("/")[0] ?? "";
  if (!withoutPath) {
    return null;
  }
  return `${schemeFallback}://${withoutPath}`;
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

function isPrivateIPv4(address: string): boolean {
  return isRfc1918Ipv4Address(address);
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

function pickLanIPv4(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
): string | null {
  return pickIPv4Matching(networkInterfaces, isPrivateIPv4);
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
  const remoteUrl =
    typeof remoteUrlRaw === "string" && remoteUrlRaw.trim()
      ? normalizeUrl(remoteUrlRaw, scheme)
      : null;
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHostWithRunner(opts.runCommandWithTimeout);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    return { url: `wss://${host}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const bindResult = resolveGatewayBindUrl({
    bind: cfg.gateway?.bind,
    customBindHost: cfg.gateway?.customBindHost,
    scheme,
    port,
    pickTailnetHost: () => pickTailnetIPv4(opts.networkInterfaces),
    pickLanHost: () => pickLanIPv4(opts.networkInterfaces),
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
    hasTokenCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
    hasPasswordCandidate: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
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

  return {
    ok: true,
    payload: {
      url: urlResult.url,
      bootstrapToken: (
        await issueDeviceBootstrapToken({
          baseDir: options.pairingBaseDir,
          profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
        })
      ).token,
    },
    authLabel: authLabel.label,
    urlSource: urlResult.source ?? "unknown",
  };
}
