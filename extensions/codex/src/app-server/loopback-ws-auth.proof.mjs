// Proof: Codex WS loopback classification correctly rejects DNS hostnames
// that start with "127." while preserving literal IPv4 loopback addresses.
//
// Origin/main uses isLoopbackHost() from openclaw/plugin-sdk/ssrf-runtime,
// which calls isLoopbackIpAddress() from @openclaw/net-policy/ip. That
// function uses parseCanonicalIpAddress() which only accepts valid IP
// literals — DNS hostnames like 127.evil.com are rejected.
//
// This script verifies the canonical IP parsing logic used by the
// production code: isLoopbackHost → isLoopbackAddress → isLoopbackIpAddress.
//
// Run: node extensions/codex/src/app-server/loopback-ws-auth.proof.mjs

// Inline the production logic from @openclaw/net-policy/ip:
// parseCanonicalIpAddress + isLoopbackIpAddress
import ipaddr from "ipaddr.js";

function parseCanonicalIpAddress(raw) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!normalized) return undefined;
  const isCanonical =
    ipaddr.IPv4.isValidFourPartDecimal(normalized) || ipaddr.IPv6.isValid(normalized);
  return isCanonical ? ipaddr.parse(normalized) : undefined;
}

function normalizeIpv4MappedAddress(address) {
  if (address.kind() === "ipv6" && address.isIPv4MappedAddress()) {
    return address.toIPv4Address();
  }
  return address;
}

function isLoopbackIpAddress(raw) {
  const parsed = parseCanonicalIpAddress(raw);
  if (!parsed) return false;
  const normalized = normalizeIpv4MappedAddress(parsed);
  return normalized.range() === "loopback";
}

// isLoopbackWebSocketUrl from config-security.ts:
// function isLoopbackWebSocketUrl(value) {
//   const parsed = new URL(value);
//   if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
//   return isLoopbackHost(parsed.hostname);
// }
//
// isLoopbackHost from src/gateway/net.ts:
// function isLoopbackHost(host) {
//   const parsed = parseHostForAddressChecks(host);
//   if (!parsed) return false;
//   if (parsed.isLocalhost) return true;
//   return isLoopbackAddress(parsed.unbracketedHost);
// }
// → isLoopbackAddress → isLoopbackIpAddress (the function we test here)

const TEST_CASES = [
  // [hostname, shouldBeLoopback, description]
  ["127.0.0.1", true, "literal IPv4 loopback", "auth-free"],
  ["127.255.255.254", true, "127/8 range", "auth-free"],
  ["::1", true, "IPv6 loopback", "auth-free"],
  ["127.evil.com", false, "DNS 127.evil.com — BYPASS CANDIDATE", "remote (needs auth)"],
  ["127.example.com", false, "DNS 127.example.com — BYPASS CANDIDATE", "remote (needs auth)"],
  ["ws.127.com", false, "DNS ws.127.com — BYPASS CANDIDATE", "remote (needs auth)"],
  ["remote.example.com", false, "remote hostname", "remote (needs auth)"],
  ["::ffff:127.0.0.1", true, "IPv4-mapped IPv6 loopback", "auth-free"],
  ["0.0.0.0", false, "unspecified IPv4", "remote (needs auth)"],
];

console.log("=== Codex WS loopback auth classification proof ===");
console.log("Testing isLoopbackIpAddress (same logic as production code)");
console.log("");

let passed = 0;
let failed = 0;
let bypassVulnerabilities = 0;

for (const [host, expected, desc, classification] of TEST_CASES) {
  const actual = isLoopbackIpAddress(host);
  const ok = actual === expected;
  const status = ok ? "✅ PASS" : "🔴 FAIL";

  const hostCol = host.padEnd(25);
  const descCol = desc.padEnd(48);
  const clsCol = classification.padEnd(20);

  console.log(
    `  ${status} | ${hostCol} | ${descCol} | loopback=${String(actual).padEnd(5)} | ${clsCol}`,
  );

  if (!ok) {
    failed++;
    if (desc.includes("BYPASS") && actual) {
      bypassVulnerabilities++;
      console.log("          ⚠️  SECURITY: DNS hostname incorrectly classified as loopback!");
    }
  } else {
    passed++;
  }
}

console.log(`\n${passed}/${TEST_CASES.length} passed, ${failed} failed`);

if (bypassVulnerabilities > 0) {
  console.log(`\n🔴 ${bypassVulnerabilities} DNS bypass vulnerabilities detected!`);
  console.log('   Fix: Add isIP(host) === 4 guard before host.startsWith("127.")');
  process.exit(1);
}

if (failed === 0) {
  console.log("\n✅ All cases correct:");
  console.log("   - DNS hostnames like 127.evil.com are correctly rejected");
  console.log("   - Literal IPv4 loopback addresses (127/8) are correctly allowed");
  console.log("   - IPv6 loopback (::1) and mapped IPv4 (::ffff:127.0.0.1) are correct");
  console.log("\n   Origin/main uses isLoopbackHost() which internally calls");
  console.log("   isLoopbackAddress → isLoopbackIpAddress → parseCanonicalIpAddress.");
  console.log("   This approach correctly rejects DNS hostnames without needing");
  console.log("   an explicit isIP() guard because parseCanonicalIpAddress only");
  console.log("   parses valid IP literals.");
  process.exit(0);
}

process.exit(1);
