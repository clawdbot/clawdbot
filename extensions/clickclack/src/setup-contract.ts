import net from "node:net";

export const CLICKCLACK_SETUP_CODE_CLAIM_PATH = "/api/bot-setup-codes/claim";

const LOOPBACK_ADDRESSES = new net.BlockList();
LOOPBACK_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_ADDRESSES.addAddress("::1", "ipv6");
const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

export function isClickClackSetupLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost") {
    return true;
  }
  const family = net.isIP(normalized);
  return family !== 0 && LOOPBACK_ADDRESSES.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function requireClickClackSetupApiBaseUrl(value: string, label: string): string {
  if (!value || value !== value.trim()) {
    throw new Error(`ClickClack ${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`ClickClack ${label} is invalid`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.hostname.endsWith(".") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`ClickClack ${label} is invalid`);
  }
  if (parsed.protocol === "http:" && !isClickClackSetupLoopbackHost(parsed.hostname)) {
    throw new Error(`ClickClack ${label} must use HTTPS unless it is on loopback`);
  }

  const pathname = parsed.pathname;
  let basePath = "";
  if (pathname !== "/") {
    if (
      pathname.endsWith("/") ||
      pathname.includes("//") ||
      pathname.includes("\\") ||
      pathname
        .slice(1)
        .split("/")
        .some((segment) => !BASE_PATH_SEGMENT.test(segment))
    ) {
      throw new Error(`ClickClack ${label} is invalid`);
    }
    basePath = pathname;
  }

  const canonical = parsed.origin + basePath;
  if (value !== canonical) {
    throw new Error(`ClickClack ${label} is not canonical`);
  }
  return canonical;
}

export function requireClickClackSetupClaimUrl(value: string): {
  claimUrl: string;
  apiBaseUrl: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ClickClack setup URL has an invalid claim endpoint.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.endsWith(CLICKCLACK_SETUP_CODE_CLAIM_PATH)
  ) {
    throw new Error("ClickClack setup URL has an invalid claim endpoint.");
  }
  const basePath = parsed.pathname.slice(0, -CLICKCLACK_SETUP_CODE_CLAIM_PATH.length);
  const apiBaseUrl = requireClickClackSetupApiBaseUrl(
    parsed.origin + basePath,
    "setup URL API base",
  );
  const claimUrl = apiBaseUrl + CLICKCLACK_SETUP_CODE_CLAIM_PATH;
  if (value !== claimUrl) {
    throw new Error("ClickClack setup URL has a non-canonical claim endpoint.");
  }
  return { claimUrl, apiBaseUrl };
}

export function buildClickClackSetupClaimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "") + CLICKCLACK_SETUP_CODE_CLAIM_PATH;
}
