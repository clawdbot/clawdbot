import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { isIpv6Address, parseCanonicalIpAddress } from "../shared/net/ip.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const TAILSCALE_EXPOSURE_OPTIONS = [
  { value: "off", label: "Off", hint: "No Tailscale exposure" },
  {
    value: "serve",
    label: "Serve",
    hint: "Private HTTPS for your tailnet (devices on Tailscale)",
  },
  {
    value: "funnel",
    label: "Funnel",
    hint: "Public HTTPS via Tailscale Funnel (internet)",
  },
] as const;

export const TAILSCALE_MISSING_BIN_NOTE_LINES = [
  "Tailscale binary not found in PATH or /Applications.",
  "Ensure Tailscale is installed from:",
  "  https://tailscale.com/download/mac",
  "",
  "You can continue setup, but serve/funnel will fail at runtime.",
] as const;

export const TAILSCALE_DOCS_LINES = [
  "Docs:",
  "https://docs.openclaw.ai/gateway/tailscale",
  "https://docs.openclaw.ai/web",
] as const;

function normalizeTailnetHostForUrl(rawHost: string): string | null {
  const trimmed = rawHost.trim().replace(/\.$/, "");
  if (!trimmed) {
    return null;
  }
  const parsed = parseCanonicalIpAddress(trimmed);
  if (parsed && isIpv6Address(parsed)) {
    return `[${normalizeLowercaseStringOrEmpty(parsed.toString())}]`;
  }
  return trimmed;
}

function buildTailnetHttpsOrigin(rawHost: string): string | null {
  const normalizedHost = normalizeTailnetHostForUrl(rawHost);
  if (!normalizedHost) {
    return null;
  }
  try {
    return new URL(`https://${normalizedHost}`).origin;
  } catch {
    return null;
  }
}

function appendAllowedOrigin(existing: string[] | undefined, origin: string): string[] {
  const current = existing ?? [];
  const normalized = normalizeLowercaseStringOrEmpty(origin);
  if (current.some((entry) => normalizeLowercaseStringOrEmpty(entry) === normalized)) {
    return current;
  }
  return [...current, origin];
}

export async function maybeAddTailnetOriginToControlUiAllowedOrigins(params: {
  config: OpenClawConfig;
  tailscaleMode: string;
  tailscaleBin?: string | null;
}): Promise<OpenClawConfig> {
  if (params.tailscaleMode !== "serve" && params.tailscaleMode !== "funnel") {
    return params.config;
  }
  const tsOrigin = await getTailnetHostname(undefined, params.tailscaleBin ?? undefined)
    .then((host) => buildTailnetHttpsOrigin(host))
    .catch(() => null);
  if (!tsOrigin) {
    return params.config;
  }

  const existing = params.config.gateway?.controlUi?.allowedOrigins ?? [];
  const updatedOrigins = appendAllowedOrigin(existing, tsOrigin);
  return {
    ...params.config,
    gateway: {
      ...params.config.gateway,
      controlUi: {
        ...params.config.gateway?.controlUi,
        allowedOrigins: updatedOrigins,
      },
    },
  };
}
