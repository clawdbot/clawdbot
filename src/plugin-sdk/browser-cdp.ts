// Browser CDP helpers connect plugin browser automation to Chrome DevTools Protocol sessions.
import { redactSensitiveText } from "../logging/redact.js";

/** Detect an operator-supplied port before WHATWG URL normalization drops default ports. */
function hasRawExplicitPort(raw: string): boolean {
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;

  if (hostPort.startsWith("[")) {
    return /^\[[^\]]+\]:\d+$/.test(hostPort);
  }

  return /:\d+$/.test(hostPort);
}

/** Parsed browser/CDP endpoint details with display-safe normalized URL variants. */
export type BrowserHttpUrlParseResult = {
  /** Parsed URL object retained for callers that need protocol, host, path, or credentials. */
  parsed: URL;
  /** Effective TCP port, including inferred 80/443 defaults. */
  port: number;
  /** Whether the raw URL text included a port, even if URL normalization drops it. */
  hasExplicitPort: boolean;
  /** URL string normalized by WHATWG URL rules with a trailing slash removed. */
  normalized: string;
  /** Normalized URL string that preserves an explicitly supplied default port. */
  normalizedWithPort: string;
};

/**
 * Parses a browser/CDP endpoint and returns both URL semantics and display-safe normalized forms.
 */
export function parseBrowserHttpUrl(raw: string, label: string): BrowserHttpUrlParseResult {
  const trimmed = raw.trim();
  const parsed = new URL(trimmed);
  const allowed = ["http:", "https:", "ws:", "wss:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new Error(`${label} must be http(s) or ws(s), got: ${parsed.protocol.replace(":", "")}`);
  }

  const isSecure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const hasExplicitPort = hasRawExplicitPort(trimmed);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : isSecure ? 443 : 80;

  if (hasExplicitPort && !parsed.port) {
    const defaultPort = isSecure ? 443 : 80;
    if (port !== defaultPort) {
      throw new Error(`${label} has invalid port: ${parsed.port}`);
    }
  }
  if (Number.isNaN(port) || port <= 0 || port > 65_535) {
    throw new Error(`${label} has invalid port: ${parsed.port}`);
  }

  const normalized = parsed.toString().replace(/\/$/, "");
  let normalizedWithPort: string;
  if (hasExplicitPort && !parsed.port) {
    // URL normalizes away default ports, but config diagnostics need to preserve
    // whether the operator explicitly wrote `:80` or `:443`.
    const proto = parsed.protocol + "//";
    const rest = normalized.slice(proto.length);
    const atIdx = rest.indexOf("@");
    const hostStart = atIdx >= 0 ? atIdx + 1 : 0;
    const hostPart = rest.slice(hostStart);
    const hostLen = hostPart.startsWith("[")
      ? hostPart.indexOf("]") + 1
      : (() => {
          const idx = hostPart.search(/[:/]/);
          return idx < 0 ? hostPart.length : idx;
        })();
    const insertAt = hostStart + hostLen;
    normalizedWithPort = proto + rest.slice(0, insertAt) + ":" + port + rest.slice(insertAt);
  } else {
    normalizedWithPort = normalized;
  }

  return {
    parsed,
    port,
    hasExplicitPort,
    normalized,
    normalizedWithPort,
  };
}

/**
 * Redacts credentials and known sensitive tokens from CDP URLs before logs or diagnostics.
 */
export function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined {
  if (typeof cdpUrl !== "string") {
    return cdpUrl;
  }
  const trimmed = cdpUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    return redactSensitiveText(parsed.toString().replace(/\/$/, ""));
  } catch {
    return redactSensitiveText(trimmed);
  }
}
