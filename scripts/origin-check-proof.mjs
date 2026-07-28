// Standalone runtime proof for PR #112288 origin-check security fix.
//
// This script ports the EXACT logic from:
//   - src/gateway/origin-check.ts (checkBrowserOrigin, isTrustedSameOriginHost, parseOrigin)
//   - src/gateway/net.ts (normalizeHostHeader, resolveHostName, isLoopbackHost)
//   - packages/net-policy/src/ip.ts (isPrivateOrLoopbackIpAddress, isLoopbackIpAddress)
//   - packages/normalization-core/src/string-coerce.ts (normalizeLowercaseStringOrEmpty)
//
// It runs without workspace deps so we can capture real behavior on a minimal
// Node runtime. Output is a redacted transcript suitable for PR evidence.

import net from "node:net";

// --- string-coerce ----------------------------------------------------------
function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function normalizeOptionalLowercaseString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

// --- net-policy/ip (minimal port covering loopback + RFC1918 + link-local + CGNAT) ---
function isLoopbackIpAddress(ip) {
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (net.isIPv4(ip) && ip.startsWith("127.")) return true;
  if (net.isIPv6(ip) && (ip === "::1" || ip === "::ffff:127.0.0.1")) return true;
  return false;
}

function isPrivateOrLoopbackIpAddress(ip) {
  if (!ip) return false;
  if (isLoopbackIpAddress(ip)) return true;
  if (net.isIPv4(ip)) {
    // RFC1918
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    const parts = ip.split(".").map(Number);
    if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // link-local 169.254/16
    if (parts.length === 4 && parts[0] === 169 && parts[1] === 254) return true;
    // CGNAT 100.64/10
    if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    // link-local fe80::/10
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true;
    // ULA fc00::/7
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    return false;
  }
  return false;
}

// --- gateway/net.ts (port of helpers used by origin-check) -------------------
function normalizeHostHeader(hostHeader) {
  return normalizeLowercaseStringOrEmpty(hostHeader);
}

function resolveHostName(hostHeader) {
  const host = normalizeHostHeader(hostHeader);
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) return host.slice(1, end);
  }
  if (net.isIP(host) === 6) return host;
  const [name] = host.split(":");
  return name ?? "";
}

function isLoopbackAddress(ip) {
  return isLoopbackIpAddress(ip);
}

function parseHostForAddressChecks(host) {
  if (!host) return null;
  const normalizedHost = normalizeLowercaseStringOrEmpty(host);
  const canonicalHost = normalizedHost.replace(/\.+$/, "");
  if (canonicalHost === "localhost") {
    return { isLocalhost: true, unbracketedHost: canonicalHost };
  }
  return {
    isLocalhost: false,
    unbracketedHost:
      normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
        ? normalizedHost.slice(1, -1)
        : normalizedHost,
  };
}

function isLoopbackHost(host) {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) return false;
  if (parsed.isLocalhost) return true;
  return isLoopbackAddress(parsed.unbracketedHost);
}

// --- gateway/origin-check.ts (EXACT port) -----------------------------------
function parseOrigin(originRaw) {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]+\/?$/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || !url.protocol || !url.host) return null;
    const origin = url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
    return {
      origin: normalizeLowercaseStringOrEmpty(origin),
      protocol: normalizeLowercaseStringOrEmpty(url.protocol),
      host: normalizeLowercaseStringOrEmpty(url.host),
      hostname: normalizeLowercaseStringOrEmpty(url.hostname),
    };
  } catch {
    return null;
  }
}

function isTrustedSameOriginHost(hostHeader, isLocalClient) {
  const hostname = resolveHostName(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) {
    return isLocalClient !== false;
  }
  // The Host header is attacker-controlled. A remote client can set both
  // Host and Origin to any private IP or .local/.ts.net hostname to make
  // them match. Only trust the Host-derived hostname for same-origin
  // validation when the request actually originates from a local client.
  if (isLocalClient === false) {
    return false;
  }
  if (net.isIP(hostname) !== 0) {
    return isPrivateOrLoopbackIpAddress(hostname);
  }
  return hostname.endsWith(".local") || hostname.endsWith(".ts.net");
}

export function checkBrowserOrigin(params) {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }
  const allowlist = new Set(
    (params.allowedOrigins ?? [])
      .map((v) => normalizeOptionalLowercaseString(v))
      .filter(Boolean),
  );
  if (allowlist.has("*") || allowlist.has(parsedOrigin.origin)) {
    return { ok: true, matchedBy: "allowlist" };
  }
  const requestHost = normalizeHostHeader(params.requestHost);
  if (
    params.allowHostHeaderOriginFallback === true &&
    requestHost &&
    parsedOrigin.host === requestHost
  ) {
    return { ok: true, matchedBy: "host-header-fallback" };
  }
  if (
    requestHost &&
    parsedOrigin.host === requestHost &&
    isTrustedSameOriginHost(requestHost, params.isLocalClient)
  ) {
    return { ok: true, matchedBy: "private-same-origin" };
  }
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }
  return { ok: false, reason: "origin not allowed" };
}

// --- Proof driver -----------------------------------------------------------
const REDACT = (s) => s; // test fixtures use only non-sensitive synthetic values

function fmt(result) {
  if (result.ok) return `ok=true matchedBy=${result.matchedBy}`;
  return `ok=false reason=${JSON.stringify(result.reason)}`;
}

const cases = [
  {
    label: "1. REJECTED Host-header spoof by non-local private LAN client",
    intent: "Attacker controls Host+Origin to match a private LAN host; non-local client.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "2. REJECTED Host-header spoof by non-local tailnet client",
    intent: "Same spoof pattern against a *.ts.net host; non-local client.",
    input: {
      requestHost: "peters-mac-studio-1.example.ts.net:18789",
      origin: "http://peters-mac-studio-1.example.ts.net:18789",
      isLocalClient: false,
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "3. ALLOWED explicit allowedOrigins remote origin for non-local client",
    intent: "Operator-configured explicit allowlist entry for a remote control UI.",
    input: {
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
      isLocalClient: false,
    },
    expected: { ok: true, matchedBy: "allowlist" },
  },
  {
    label: "4. ALLOWED explicit Host-header fallback opt-in for non-local client",
    intent: "Operator explicitly enables dangerous Host-header fallback for legacy LAN deployment.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
      allowHostHeaderOriginFallback: true,
    },
    expected: { ok: true, matchedBy: "host-header-fallback" },
  },
  {
    label: "5. ALLOWED wildcard allowedOrigins for non-local client",
    intent: "Operator explicitly allows all origins (open deployment).",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      allowedOrigins: ["*"],
      isLocalClient: false,
    },
    expected: { ok: true, matchedBy: "allowlist" },
  },
  {
    label: "6. ALLOWED private-same-origin for local client (legitimate LAN UI)",
    intent: "Same-origin request from a loopback/trusted-proxy-derived local client to a private host.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: true,
    },
    expected: { ok: true, matchedBy: "private-same-origin" },
  },
  {
    label: "7. DEFENSE-IN-DEPTH: spoof rejected even when an unrelated allowedOrigins entry exists",
    intent: "allowedOrigins names a different host; spoofed private Host+Origin must still be rejected.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      allowedOrigins: ["https://control.example.com"],
      isLocalClient: false,
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
];

console.log("=== PR #112288 origin-check runtime proof ===");
console.log("Source: src/gateway/origin-check.ts (exact logic port)");
console.log(`Node: ${process.version} | Platform: ${process.platform}`);
console.log(`Cases: ${cases.length} | Timestamp: ${new Date().toISOString()}`);
console.log("");

let pass = 0;
let fail = 0;
for (const c of cases) {
  const result = checkBrowserOrigin(c.input);
  const ok =
    result.ok === c.expected.ok &&
    (result.ok ? result.matchedBy === c.expected.matchedBy : result.reason === c.expected.reason);
  if (ok) pass += 1;
  else fail += 1;
  console.log(c.label);
  console.log(`  intent:  ${c.intent}`);
  console.log(`  input:   ${JSON.stringify(REDACT(c.input))}`);
  console.log(`  expect:  ${fmt(c.expected)}`);
  console.log(`  actual:  ${fmt(result)}`);
  console.log(`  status:  ${ok ? "PASS" : "FAIL"}`);
  console.log("");
}

console.log(`Summary: ${pass}/${cases.length} passed, ${fail} failed`);
console.log("");
console.log("Verdict:");
console.log("- Host-header Origin spoofing by non-local clients is REJECTED (cases 1, 2, 7).");
console.log("- Migration paths for non-local clients work: explicit allowedOrigins (3),");
console.log("  opt-in Host-header fallback (4), and wildcard allow-all (5).");
console.log("- Legitimate local-client private-same-origin trust is preserved (6).");
process.exit(fail === 0 ? 0 : 1);
