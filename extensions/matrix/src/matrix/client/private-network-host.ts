import net from "node:net";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

function normalizeHost(host: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1") {
    return true;
  }
  if (host === "::" || host.startsWith("ff")) {
    return false;
  }
  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

export function isPrivateOrLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost") {
    return true;
  }
  const family = net.isIP(normalized);
  if (family === 4) {
    return isPrivateIpv4(normalized);
  }
  if (family === 6) {
    return isPrivateIpv6(normalized);
  }
  return false;
}
