import { existsSync } from "node:fs";
import { promptYesNo } from "../cli/prompt.js";
import { danger, info, logVerbose, shouldLogVerbose, warn } from "../globals.js";
import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ensureBinary } from "./binaries.js";

function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
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
    if (!path || !existsSync(path)) return false;
    try {
      // Use Promise.race with runExec to implement timeout
      await Promise.race([
        runExec(path, ["--version"], { timeoutMs: 3000 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
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
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    try {
      const { stdout } = await exec(candidate, ["status", "--json"], {
        timeoutMs: 5000,
        maxBuffer: 400_000,
      });
      const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
      const self =
        typeof parsed.Self === "object" && parsed.Self !== null
          ? (parsed.Self as Record<string, unknown>)
          : undefined;
      const dns = typeof self?.DNSName === "string" ? (self.DNSName as string) : undefined;
      const ips = Array.isArray(self?.TailscaleIPs)
        ? ((parsed.Self as { TailscaleIPs?: string[] }).TailscaleIPs ?? [])
        : [];
      if (dns && dns.length > 0) return dns.replace(/\.$/, "");
      if (ips.length > 0) return ips[0];
      throw new Error("Could not determine Tailscale DNS or IP");
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("Could not determine Tailscale DNS or IP");
}

/**
 * Get the Tailscale binary command to use.
 * Returns a cached detected binary or the default "tailscale" command.
 */
let cachedTailscaleBinary: string | null = null;

export async function getTailscaleBinary(): Promise<string> {
  if (cachedTailscaleBinary) return cachedTailscaleBinary;
  cachedTailscaleBinary = await findTailscaleBinary();
  return cachedTailscaleBinary ?? "tailscale";
}

export async function readTailscaleStatusJson(
  exec: typeof runExec = runExec,
  opts?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const tailscaleBin = await getTailscaleBinary();
  const { stdout } = await exec(tailscaleBin, ["status", "--json"], {
    timeoutMs: opts?.timeoutMs ?? 5000,
    maxBuffer: 400_000,
  });
  return stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
}

export async function ensureGoInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure Go toolchain is present; offer Homebrew install if missing.
  const hasGo = await exec("go", ["version"]).then(
    () => true,
    () => false,
  );
  if (hasGo) return;
  const install = await prompt(
    "Go is not installed. Install via Homebrew (brew install go)?",
    true,
  );
  if (!install) {
    runtime.error("Go is required to build tailscaled from source. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing Go via Homebrew…");
  await exec("brew", ["install", "go"]);
}

export async function ensureTailscaledInstalled(
  exec: typeof runExec = runExec,
  prompt: typeof promptYesNo = promptYesNo,
  runtime: RuntimeEnv = defaultRuntime,
) {
  // Ensure tailscaled binary exists; install via Homebrew tailscale if missing.
  const hasTailscaled = await exec("tailscaled", ["--version"]).then(
    () => true,
    () => false,
  );
  if (hasTailscaled) return;

  const install = await prompt(
    "tailscaled not found. Install via Homebrew (tailscale package)?",
    true,
  );
  if (!install) {
    runtime.error("tailscaled is required for user-space funnel. Aborting.");
    runtime.exit(1);
  }
  logVerbose("Installing tailscaled via Homebrew…");
  await exec("brew", ["install", "tailscale"]);
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
  if (code.toUpperCase() === "EACCES") return true;
  const combined = `${stdout}\n${stderr}\n${message}`.toLowerCase();
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
      if (detail) logVerbose(`Sudo retry failed: ${detail}`);
      throw err;
    }
  }
}

export async function ensureFunnel(
  port: number,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
  prompt: typeof promptYesNo = promptYesNo,
) {
  // Ensure Funnel is enabled and publish the webhook port.
  try {
    const tailscaleBin = await getTailscaleBinary();
    const statusOut = (await exec(tailscaleBin, ["funnel", "status", "--json"])).stdout.trim();
    const parsed = statusOut ? (JSON.parse(statusOut) as Record<string, unknown>) : {};
    if (!parsed || Object.keys(parsed).length === 0) {
      runtime.error(danger("Tailscale Funnel is not enabled on this tailnet/device."));
      runtime.error(
        info(
          "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
        ),
      );
      runtime.error(
        info(
          "macOS user-space tailscaled docs: https://github.com/tailscale/tailscale/wiki/Tailscaled-on-macOS",
        ),
      );
      const proceed = await prompt("Attempt local setup with user-space tailscaled?", true);
      if (!proceed) runtime.exit(1);
      await ensureBinary("brew", exec, runtime);
      await ensureGoInstalled(exec, prompt, runtime);
      await ensureTailscaledInstalled(exec, prompt, runtime);
    }

    logVerbose(`Enabling funnel on port ${port}…`);
    // Attempt with fallback
    const { stdout } = await execWithSudoFallback(
      exec,
      tailscaleBin,
      ["funnel", "--yes", "--bg", `${port}`],
      {
        maxBuffer: 200_000,
        timeoutMs: 15_000,
      },
    );
    if (stdout.trim()) console.log(stdout.trim());
  } catch (err) {
    const errOutput = err as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof errOutput.stdout === "string" ? errOutput.stdout : "";
    const stderr = typeof errOutput.stderr === "string" ? errOutput.stderr : "";
    if (stdout.includes("Funnel is not enabled")) {
      console.error(danger("Funnel is not enabled on this tailnet/device."));
      const linkMatch = stdout.match(/https?:\/\/\S+/);
      if (linkMatch) {
        console.error(info(`Enable it here: ${linkMatch[0]}`));
      } else {
        console.error(
          info(
            "Enable in admin console: https://login.tailscale.com/admin (see https://tailscale.com/kb/1223/funnel)",
          ),
        );
      }
    }
    if (stderr.includes("client version") || stdout.includes("client version")) {
      console.error(
        warn(
          "Tailscale client/server version mismatch detected; try updating tailscale/tailscaled.",
        ),
      );
    }
    runtime.error("Failed to enable Tailscale Funnel. Is it allowed on your tailnet?");
    runtime.error(
      info(
        `Tip: Funnel is optional for Moltbot. You can keep running the web gateway without it: \`${formatCliCommand("moltbot gateway")}\``,
      ),
    );
    if (shouldLogVerbose()) {
      const rich = isRich();
      if (stdout.trim()) {
        runtime.error(colorize(rich, theme.muted, `stdout: ${stdout.trim()}`));
      }
      if (stderr.trim()) {
        runtime.error(colorize(rich, theme.muted, `stderr: ${stderr.trim()}`));
      }
      runtime.error(err as Error);
    }
    runtime.exit(1);
  }
}

export async function enableTailscaleServe(port: number, exec: typeof runExec = runExec) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(exec, tailscaleBin, ["serve", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleServe(exec: typeof runExec = runExec) {
  const tailscaleBin = await getTailscaleBinary();
  await execWithSudoFallback(exec, tailscaleBin, ["serve", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
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

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseWhoisIdentity(payload: Record<string, unknown>): TailscaleWhoisIdentity | null {
  const userProfile =
    readRecord(payload.UserProfile) ?? readRecord(payload.userProfile) ?? readRecord(payload.User);
  const login =
    getString(userProfile?.LoginName) ??
    getString(userProfile?.Login) ??
    getString(userProfile?.login) ??
    getString(payload.LoginName) ??
    getString(payload.login);
  if (!login) return null;
  const name =
    getString(userProfile?.DisplayName) ??
    getString(userProfile?.Name) ??
    getString(userProfile?.displayName) ??
    getString(payload.DisplayName) ??
    getString(payload.name);
  return { login, name };
}

function readCachedWhois(ip: string, now: number): TailscaleWhoisIdentity | null | undefined {
  const cached = whoisCache.get(ip);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    whoisCache.delete(ip);
    return undefined;
  }
  return cached.value;
}

function writeCachedWhois(ip: string, value: TailscaleWhoisIdentity | null, ttlMs: number) {
  whoisCache.set(ip, { value, expiresAt: Date.now() + ttlMs });
}

export async function readTailscaleWhoisIdentity(
  ip: string,
  exec: typeof runExec = runExec,
  opts?: { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number },
): Promise<TailscaleWhoisIdentity | null> {
  const normalized = ip.trim();
  if (!normalized) return null;
  const now = Date.now();
  const cached = readCachedWhois(normalized, now);
  if (cached !== undefined) return cached;

  const cacheTtlMs = opts?.cacheTtlMs ?? 60_000;
  const errorTtlMs = opts?.errorTtlMs ?? 5_000;
  try {
    const tailscaleBin = await getTailscaleBinary();
    const { stdout } = await exec(tailscaleBin, ["whois", "--json", normalized], {
      timeoutMs: opts?.timeoutMs ?? 5_000,
      maxBuffer: 200_000,
    });
    const parsed = stdout ? parsePossiblyNoisyJsonObject(stdout) : {};
    const identity = parseWhoisIdentity(parsed);
    writeCachedWhois(normalized, identity, cacheTtlMs);
    return identity;
  } catch {
    writeCachedWhois(normalized, null, errorTtlMs);
    return null;
  }
}
