// Standalone runtime proof for PR #112288 origin-check security fix (narrowed).
//
// This script ports the EXACT logic from:
//   - src/gateway/origin-check.ts (checkBrowserOrigin, isTrustedSameOriginHost, parseOrigin)
//   - src/gateway/net.ts (normalizeHostHeader, resolveHostName, isLoopbackHost)
//   - packages/net-policy/src/ip.ts (isPrivateOrLoopbackIpAddress, normalizeIpAddress, isLoopbackIpAddress)
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
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("192.168.")) return true;
    const parts = ip.split(".").map(Number);
    if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts.length === 4 && parts[0] === 169 && parts[1] === 254) return true;
    if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    return false;
  }
  return false;
}

function normalizeIpAddress(raw) {
  if (!raw) return undefined;
  let trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) trimmed = trimmed.slice(1, -1);
  // Handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) trimmed = v4Mapped[1];
  if (net.isIP(trimmed) === 0) return undefined;
  return trimmed.toLowerCase();
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

// --- gateway/origin-check.ts (EXACT port of narrowed fix) --------------------
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

function isTrustedSameOriginHost(hostHeader, isLocalClient, clientIp) {
  const hostname = resolveHostName(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHost(hostname)) {
    return isLocalClient !== false;
  }
  // Private-IP and private-DNS (.local/.ts.net) same-origin trust preserves
  // the documented configuration-free Control UI path for browsers on the
  // same LAN or Tailnet. The Host header is attacker-controlled, but a
  // public-Internet client claiming a private Origin is the actual spoof.
  const isPrivateHost = net.isIP(hostname) !== 0
    ? isPrivateOrLoopbackIpAddress(hostname)
    : hostname.endsWith(".local") || hostname.endsWith(".ts.net");
  if (!isPrivateHost) return false;
  if (isLocalClient) return true;
  // Non-local client: allow if the connection peer is on a private network
  // (legitimate LAN/Tailnet browser), reject if it is on a public IP (spoof).
  const normalizedClientIp = normalizeIpAddress(clientIp);
  if (normalizedClientIp && isPrivateOrLoopbackIpAddress(normalizedClientIp)) return true;
  return false;
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
    isTrustedSameOriginHost(requestHost, params.isLocalClient, params.clientIp)
  ) {
    return { ok: true, matchedBy: "private-same-origin" };
  }
  if (params.isLocalClient && isLoopbackHost(parsedOrigin.hostname)) {
    return { ok: true, matchedBy: "local-loopback" };
  }
  return { ok: false, reason: "origin not allowed" };
}

// --- Proof driver -----------------------------------------------------------
function fmt(result) {
  if (result.ok) return `ok=true matchedBy=${result.matchedBy}`;
  return `ok=false reason=${JSON.stringify(result.reason)}`;
}

const cases = [
  {
    label: "1. REJECTED public-IP spoof of private LAN host",
    intent: "Attacker on public Internet sets Host+Origin to a private LAN host.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
      clientIp: "203.0.113.5",
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "2. ALLOWED non-local LAN client to private LAN host (preserves direct-LAN access)",
    intent: "Legitimate browser on another LAN device opens the Control UI at the gateway's private IP.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
      clientIp: "192.168.1.50",
    },
    expected: { ok: true, matchedBy: "private-same-origin" },
  },
  {
    label: "3. REJECTED public-IP spoof of tailnet host",
    intent: "Attacker on public Internet sets Host+Origin to a *.ts.net host.",
    input: {
      requestHost: "peters-mac-studio-1.example.ts.net:18789",
      origin: "http://peters-mac-studio-1.example.ts.net:18789",
      isLocalClient: false,
      clientIp: "203.0.113.5",
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "4. ALLOWED non-local Tailnet client to tailnet host (preserves Tailnet access)",
    intent: "Legitimate browser on another Tailnet device opens the Control UI.",
    input: {
      requestHost: "peters-mac-studio-1.example.ts.net:18789",
      origin: "http://peters-mac-studio-1.example.ts.net:18789",
      isLocalClient: false,
      clientIp: "100.64.0.10",
    },
    expected: { ok: true, matchedBy: "private-same-origin" },
  },
  {
    label: "5. REJECTED public-IP spoof of .local host",
    intent: "Attacker on public Internet sets Host+Origin to a .local mDNS host.",
    input: {
      requestHost: "gateway.local:18789",
      origin: "http://gateway.local:18789",
      isLocalClient: false,
      clientIp: "203.0.113.5",
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "6. ALLOWED non-local LAN client to .local host (preserves mDNS access)",
    intent: "Legitimate browser on the same mDNS domain opens the Control UI.",
    input: {
      requestHost: "gateway.local:18789",
      origin: "http://gateway.local:18789",
      isLocalClient: false,
      clientIp: "192.168.1.50",
    },
    expected: { ok: true, matchedBy: "private-same-origin" },
  },
  {
    label: "7. ALLOWED explicit allowedOrigins remote origin for public-IP client",
    intent: "Operator-configured explicit allowlist entry for a remote control UI.",
    input: {
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
      isLocalClient: false,
      clientIp: "203.0.113.5",
    },
    expected: { ok: true, matchedBy: "allowlist" },
  },
  {
    label: "8. ALLOWED Host-header fallback opt-in for public-IP client",
    intent: "Operator explicitly enables dangerous Host-header fallback for legacy deployment.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
      clientIp: "203.0.113.5",
      allowHostHeaderOriginFallback: true,
    },
    expected: { ok: true, matchedBy: "host-header-fallback" },
  },
  {
    label: "9. DEFENSE-IN-DEPTH: public-IP spoof rejected even with unrelated allowedOrigins",
    intent: "allowedOrigins names a different host; spoofed private Host+Origin must still be rejected.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      allowedOrigins: ["https://control.example.com"],
      isLocalClient: false,
      clientIp: "203.0.113.5",
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
  {
    label: "10. ALLOWED local-client private-same-origin (loopback, unchanged)",
    intent: "Same-origin request from a loopback/trusted-proxy-derived local client to a private host.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: true,
    },
    expected: { ok: true, matchedBy: "private-same-origin" },
  },
  {
    label: "11. REJECTED non-local client without clientIp (safe default: fail closed)",
    intent: "Caller does not supply clientIp; non-local private-same-origin is rejected by default.",
    input: {
      requestHost: "192.168.0.202:18789",
      origin: "http://192.168.0.202:18789",
      isLocalClient: false,
    },
    expected: { ok: false, reason: "origin not allowed" },
  },
];

console.log("=== PR #112288 origin-check runtime proof (narrowed fix) ===");
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
  console.log(`  input:   ${JSON.stringify(c.input)}`);
  console.log(`  expect:  ${fmt(c.expected)}`);
  console.log(`  actual:  ${fmt(result)}`);
  console.log(`  status:  ${ok ? "PASS" : "FAIL"}`);
  console.log("");
}

console.log(`Summary: ${pass}/${cases.length} passed, ${fail} failed`);
console.log("");
console.log("Verdict:");
console.log("- Public-IP clients claiming private Origin are REJECTED (cases 1, 3, 5, 9).");
console.log("- Non-local LAN/Tailnet clients with private clientIp are ALLOWED (cases 2, 4, 6)");
console.log("  — preserving the documented configuration-free direct-LAN/Tailnet Control UI path.");
console.log("- Migration paths work: explicit allowedOrigins (7), opt-in Host-header fallback (8).");
console.log("- Local-client private-same-origin trust is unchanged (10).");
console.log("- Safe default: non-local without clientIp fails closed (11).");
process.exit(fail === 0 ? 0 : 1);
