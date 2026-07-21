// Integrates with the local Tailscale CLI for tailnet setup and sharing.
import { existsSync } from "node:fs";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import { toErrorObject } from "./errors.js";
import { retryAsync } from "./retry.js";

const TAILSCALE_STATUS_ATTEMPTS = 3;
const TAILSCALE_STATUS_RETRY_DELAY_MS = 500;

function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function tailnetHostnameFromStatus(parsed: Record<string, unknown>): string {
  const self =
    typeof parsed.Self === "object" && parsed.Self !== null
      ? (parsed.Self as Record<string, unknown>)
      : undefined;
  const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
  const ips = Array.isArray(self?.TailscaleIPs)
    ? ((parsed.Self as { TailscaleIPs?: string[] }).TailscaleIPs ?? [])
    : [];
  if (dns && dns.length > 0) {
    return dns.replace(/\.$/, "");
  }
  const [firstIp] = ips;
  if (firstIp !== undefined) {
    return firstIp;
  }
  throw new Error("Could not determine Tailscale DNS or IP");
}

function isTransientTailscaleStatusError(error: unknown): boolean {
  const record = readRecord(error);
  const detail = [
    error instanceof Error ? error.message : undefined,
    typeof record?.stderr === "string" ? record.stderr : undefined,
    typeof record?.stdout === "string" ? record.stdout : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  return (
    record?.timedOut === true ||
    detail.includes("failed to connect to local tailscale daemon") ||
    detail.includes("failed to connect to local tailscale service") ||
    detail.includes("connection refused") ||
    detail.includes("503 service unavailable")
  );
}

/**
 * Locate Tailscale binary using multiple strategies:
 * 1. PATH lookup (via which command)
 * 2. Known macOS app path
 * 3. find /Applications for Tailscale.app
 * 4. locate database (if available)
 *
 * @returns Path to Tailscale binary or null if not found
 */
export async function findTailscaleBinary(): Promise<string | null> {
  // Helper to check if a binary exists and is executable
  const checkBinary = async (path: string): Promise<boolean> => {
    if (!path || !existsSync(path)) {
      return false;
    }
    try {
      await runExec(path, ["--version"], { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  };

  // Strategy 1: which command
  try {
    const { stdout } = await runExec("which", ["tailscale"]);
    const fromPath = stdout.trim();
    if (fromPath && (await checkBinary(fromPath))) {
      return fromPath;
    }
  } catch {
    // which failed, continue
  }

  // Strategy 2: Known macOS app path
  const macAppPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (await checkBinary(macAppPath)) {
    return macAppPath;
  }

  // Strategy 3: find command in /Applications
  try {
    const { stdout } = await runExec(
      "find",
      [
        "/Applications",
        "-maxdepth",
        "3",
        "-name",
        "Tailscale",
        "-path",
        "*/Tailscale.app/Contents/MacOS/Tailscale",
      ],
      { timeoutMs: 5000 },
    );
    const found = stdout.trim().split("\n")[0];
    if (found && (await checkBinary(found))) {
      return found;
    }
  } catch {
    // find failed, continue
  }

  // Strategy 4: locate command
  try {
    const { stdout } = await runExec("locate", ["Tailscale.app"]);
    const candidates = stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes("/Tailscale.app/Contents/MacOS/Tailscale"));
    for (const candidate of candidates) {
      if (await checkBinary(candidate)) {
        return candidate;
      }
    }
  } catch {
    // locate failed, continue
  }

  return null;
}

export async function getTailnetHostname(exec: typeof runExec = runExec, detectedBinary?: string) {
  // Derive tailnet hostname (or IP fallback) from tailscale status JSON.
  const candidates = detectedBinary
    ? [detectedBinary]
    : ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  let lastError: unknown;

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) {
      continue;
    }
    try {
      const { stdout } = await exec(candidate, ["status", "--json"], {
        timeoutMs: 5000,
        maxBuffer: 400_000,
      });
      return tailnetHostnameFromStatus(stdout ? parsePossiblyNoisyJsonObject(stdout) : {});
    } catch (err) {
      lastError = err;
    }
  }

  throw toErrorObject(
    lastError ?? new Error("Could not determine Tailscale DNS or IP"),
    "Non-Error thrown",
  );
}

/**
 * Get the Tailscale binary command to use.
 * Returns a cached detected binary or the default "tailscale" command.
 */
let cachedTailscaleBinary: string | null = null;

function getTestTailscaleBinaryOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const forcedBinary = env.OPENCLAW_TEST_TAILSCALE_BINARY?.trim();
  if (!forcedBinary) {
    return null;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return forcedBinary;
  }
  return null;
}

async function getTailscaleBinary(): Promise<string> {
  const forcedBinary = getTestTailscaleBinaryOverride();
  if (forcedBinary) {
    cachedTailscaleBinary = forcedBinary;
    return forcedBinary;
  }
  if (cachedTailscaleBinary) {
    return cachedTailscaleBinary;
  }
  cachedTailscaleBinary = await findTailscaleBinary();
  return cachedTailscaleBinary ?? "tailscale";
}

/** Resolve the hostname after Serve startup, while the local daemon may still be settling. */
export async function getTailnetHostnameAfterServe(
  exec: typeof runExec = runExec,
): Promise<string> {
  const candidate = await getTailscaleBinary();
  const parsed = await retryAsync(
    async () => {
      const { stdout } = await exec(candidate, ["status", "--json"], {
        timeoutMs: 5000,
        maxBuffer: 400_000,
        // Hostname discovery is best-effort. Avoid scary command-failure logs while the
        // local daemon settles after Serve configuration.
        logOutput: false,
      });
      return stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    },
    {
      attempts: TAILSCALE_STATUS_ATTEMPTS,
      minDelayMs: TAILSCALE_STATUS_RETRY_DELAY_MS,
      maxDelayMs: TAILSCALE_STATUS_RETRY_DELAY_MS,
      jitter: 0,
      shouldRetry: isTransientTailscaleStatusError,
    },
  );
  return tailnetHostnameFromStatus(parsed);
}

type ExecErrorDetails = {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
  code?: unknown;
};

export type TailscaleWhoisIdentity = {
  login: string;
  name?: string;
};

type TailscaleWhoisCacheEntry = {
  value: TailscaleWhoisIdentity | null;
  expiresAt: number;
};

const whoisCache = new Map<string, TailscaleWhoisCacheEntry>();

function extractExecErrorText(err: unknown) {
  const errOutput = err as ExecErrorDetails;
  const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
  const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
  const message = typeof errOutput.message === "string" ? errOutput.message : "";
  const code = typeof errOutput.code === "string" ? errOutput.code : "";
  return { stdout, stderr, message, code };
}

function isPermissionDeniedError(err: unknown): boolean {
  const { stdout, stderr, message, code } = extractExecErrorText(err);
  if (code.toUpperCase() === "EACCES") {
    return true;
  }
  const combined = normalizeLowercaseStringOrEmpty(`${stdout}\n${stderr}\n${message}`);
  return (
    combined.includes("permission denied") ||
    combined.includes("access denied") ||
    combined.includes("operation not permitted") ||
    combined.includes("not permitted") ||
    combined.includes("requires root") ||
    combined.includes("must be run as root") ||
    combined.includes("must be run with sudo") ||
    combined.includes("requires sudo") ||
    combined.includes("need sudo")
  );
}

// Helper to attempt a command, and retry with sudo if it fails.
async function execWithSudoFallback(
  exec: typeof runExec,
  bin: string,
  args: string[],
  opts: { maxBuffer?: number; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(bin, args, opts);
  } catch (err) {
    if (!isPermissionDeniedError(err)) {
      throw err;
    }
    logVerbose(`Command failed, retrying with sudo: ${bin} ${args.join(" ")}`);
    try {
      return await exec("sudo", ["-n", bin, ...args], opts);
    } catch (sudoErr) {
      const { stderr, message } = extractExecErrorText(sudoErr);
      const detail = (stderr || message).trim();
      if (detail) {
        logVerbose(`Sudo retry failed: ${detail}`);
      }
      throw err;
    }
  }
}

export async function enableTailscaleServe(
  port: number,
  exec: typeof runExec = runExec,
  serviceName?: string,
) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(
    exec,
    tailscaleBin,
    ["serve", ...(serviceName ? [`--service=${serviceName}`] : []), "--bg", "--yes", `${port}`],
    {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    },
  );
}

export async function hasTailscaleFunnelRouteForPort(
  port: number,
  exec: typeof runExec = runExec,
): Promise<boolean> {
  let stdout: string;
  try {
    const tailscaleBin = await getTailscaleBinary();
    const result = await exec(tailscaleBin, ["funnel", "status", "--json"], {
      maxBuffer: 200_000,
      timeoutMs: 5_000,
    });
    stdout = result.stdout;
  } catch {
    return false;
  }
  const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
  return tailscaleFunnelStatusCoversPort(parsed, port);
}

const TAILSCALE_LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function tailscaleFunnelStatusCoversPort(status: Record<string, unknown>, port: number): boolean {
  for (const proxy of funnelStatusBackendsForPort(status)) {
    if (tailscaleProxyMatchesLoopbackPort(proxy, port)) {
      return true;
    }
  }
  return false;
}

function tailscaleProxyMatchesLoopbackPort(proxy: string, port: number): boolean {
  // Tailscale stores the Proxy field as a full URL string (e.g.
  // "http://127.0.0.1:18789", "http://127.0.0.1:18789/",
  // "https+insecure://localhost:18789/api"), or as the bare forms accepted
  // by `tailscale funnel/serve` ("localhost:18789", "18789"). Strip any
  // RFC 3986 scheme (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) "://") and
  // any trailing path before host/port match — covers documented Tailscale
  // target schemes such as `http`, `https`, and `https+insecure`.
  const stripped = proxy.replace(/^[a-z][a-z0-9+\-.]*:\/\//i, "").replace(/\/.*$/, "");
  if (stripped === String(port)) {
    return true;
  }
  const sep = stripped.lastIndexOf(":");
  if (sep < 0) {
    return false;
  }
  const host = stripped.slice(0, sep);
  const portStr = stripped.slice(sep + 1);
  if (portStr !== String(port)) {
    return false;
  }
  return TAILSCALE_LOOPBACK_PROXY_HOSTS.has(host);
}

function funnelStatusBackendsForPort(status: Record<string, unknown>): Set<string> {
  const backends = new Set<string>();
  const allowFunnel = (status as { AllowFunnel?: Record<string, unknown> }).AllowFunnel ?? {};
  const enabledHosts = new Set(
    Object.entries(allowFunnel)
      .filter(([, value]) => value === true)
      .map(([host]) => host),
  );
  if (enabledHosts.size === 0) {
    return backends;
  }
  const web = (status as { Web?: Record<string, unknown> }).Web;
  if (!web || typeof web !== "object") {
    return backends;
  }
  for (const [host, handlers] of Object.entries(web)) {
    if (!enabledHosts.has(host)) {
      continue;
    }
    if (!handlers || typeof handlers !== "object") {
      continue;
    }
    const handlerEntries = (handlers as { Handlers?: Record<string, unknown> }).Handlers;
    if (!handlerEntries || typeof handlerEntries !== "object") {
      continue;
    }
    for (const handler of Object.values(handlerEntries)) {
      const proxy = (handler as { Proxy?: unknown })?.Proxy;
      if (typeof proxy === "string" && proxy.length > 0) {
        backends.add(proxy);
      }
    }
  }
  return backends;
}

export async function disableTailscaleServe(exec: typeof runExec = runExec, serviceName?: string) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(
    exec,
    tailscaleBin,
    serviceName ? ["serve", "clear", serviceName] : ["serve", "reset"],
    {
      maxBuffer: 200_000,
      timeoutMs: 15_000,
    },
  );
}

export async function enableTailscaleFunnel(port: number, exec: typeof runExec = runExec) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(exec, tailscaleBin, ["funnel", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleFunnel(exec: typeof runExec = runExec) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(exec, tailscaleBin, ["funnel", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

function parseWhoisIdentity(payload: Record<string, unknown>): TailscaleWhoisIdentity | null {
  const userProfile =
    readRecord(payload.UserProfile) ?? readRecord(payload.userProfile) ?? readRecord(payload.User);
  const login =
    normalizeOptionalString(userProfile?.LoginName) ??
    normalizeOptionalString(userProfile?.Login) ??
    normalizeOptionalString(userProfile?.login) ??
    normalizeOptionalString(payload.LoginName) ??
    normalizeOptionalString(payload.login);
  if (!login) {
    return null;
  }
  const name =
    normalizeOptionalString(userProfile?.DisplayName) ??
    normalizeOptionalString(userProfile?.Name) ??
    normalizeOptionalString(userProfile?.displayName) ??
    normalizeOptionalString(payload.DisplayName) ??
    normalizeOptionalString(payload.name);
  return { login, name };
}

function readCachedWhois(ip: string, now: number): TailscaleWhoisIdentity | null | undefined {
  const validNow = asDateTimestampMs(now);
  if (validNow === undefined) {
    return undefined;
  }
  const cached = whoisCache.get(ip);
  if (!cached) {
    return undefined;
  }
  const expiresAt = asDateTimestampMs(cached.expiresAt);
  if (expiresAt === undefined || expiresAt <= validNow) {
    whoisCache.delete(ip);
    return undefined;
  }
  return cached.value;
}

function writeCachedWhois(ip: string, value: TailscaleWhoisIdentity | null, ttlMs: number): void {
  const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs);
  if (expiresAt !== undefined) {
    whoisCache.set(ip, { value, expiresAt });
  }
}

export async function readTailscaleWhoisIdentity(
  ip: string,
  exec: typeof runExec = runExec,
  opts?: { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number },
): Promise<TailscaleWhoisIdentity | null> {
  const normalized = ip.trim();
  if (!normalized) {
    return null;
  }
  const now = Date.now();
  const cached = readCachedWhois(normalized, now);
  if (cached !== undefined) {
    return cached;
  }

  const cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
  const errorTtlMs = opts?.errorTtlMs ?? 5_000;
  try {
    const tailscaleBin = await getTailscaleBinary();
    const result = await exec(tailscaleBin, ["whois", "--json", normalized], {
      timeoutMs: opts?.timeoutMs ?? 5_000,
      maxBuffer: 200_000,
    });
    const parsed = result.stdout ? parsePossiblyNoisyJsonObject(result.stdout) : {};
    const identity = parseWhoisIdentity(parsed);
    writeCachedWhois(normalized, identity, cacheTtlMs);
    return identity;
  } catch {
    writeCachedWhois(normalized, null, errorTtlMs);
    return null;
  }
}
