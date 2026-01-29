import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { logVerbose } from "../globals.js";
import { runExec } from "../process/exec.js";
import type { WorkspaceSyncConfig, WorkspaceSyncProvider } from "../config/types.workspace.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

const DEFAULT_REMOTE_NAME = "cloud";
const DEFAULT_LOCAL_PATH = "shared";
const DEFAULT_REMOTE_PATH = "moltbot-share";
const DEFAULT_CONFLICT_RESOLVE = "newer";
const DEFAULT_EXCLUDES = [
  ".git/**",
  "node_modules/**",
  ".venv/**",
  "__pycache__/**",
  "*.log",
  ".DS_Store",
];

export type RcloneSyncResult = {
  ok: boolean;
  error?: string;
  filesTransferred?: number;
  bytesTransferred?: number;
};

/**
 * Find rclone binary in PATH or common locations.
 */
export async function findRcloneBinary(): Promise<string | null> {
  const checkBinary = async (path: string): Promise<boolean> => {
    if (!path || (path.startsWith("/") && !existsSync(path))) return false;
    try {
      await runExec(path, ["--version"], { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  };

  // Strategy 1: which command
  try {
    const { stdout } = await runExec("which", ["rclone"]);
    const fromPath = stdout.trim();
    if (fromPath && (await checkBinary(fromPath))) {
      return fromPath;
    }
  } catch {
    // which failed, continue
  }

  // Strategy 2: Common install locations
  const commonPaths = ["/usr/local/bin/rclone", "/usr/bin/rclone", "/opt/homebrew/bin/rclone"];
  for (const path of commonPaths) {
    if (await checkBinary(path)) {
      return path;
    }
  }

  return null;
}

let cachedRcloneBinary: string | null = null;

export async function getRcloneBinary(): Promise<string> {
  if (cachedRcloneBinary) return cachedRcloneBinary;
  cachedRcloneBinary = await findRcloneBinary();
  return cachedRcloneBinary ?? "rclone";
}

/**
 * Check if rclone is installed.
 */
export async function isRcloneInstalled(): Promise<boolean> {
  const binary = await findRcloneBinary();
  return binary !== null;
}

/**
 * Ensure rclone is installed, offering to install if missing.
 * Returns true if rclone is available, false if user declined install.
 */
export async function ensureRcloneInstalled(
  prompt: (message: string, defaultValue: boolean) => Promise<boolean>,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<boolean> {
  const installed = await isRcloneInstalled();
  if (installed) return true;

  const isMac = platform() === "darwin";
  const isLinux = platform() === "linux";

  if (isMac) {
    // Check if Homebrew is available
    const hasBrew = await exec("which", ["brew"]).then(
      () => true,
      () => false,
    );

    if (hasBrew) {
      const install = await prompt(
        "rclone not found. Install via Homebrew (brew install rclone)?",
        true,
      );
      if (!install) {
        return false;
      }
      logVerbose("Installing rclone via Homebrew...");
      try {
        await exec("brew", ["install", "rclone"], { timeoutMs: 120_000 });
        // Clear cached binary so we find the new one
        cachedRcloneBinary = null;
        return true;
      } catch (err) {
        runtime.error(
          `Failed to install rclone: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
  }

  if (isLinux || isMac) {
    const install = await prompt(
      "rclone not found. Install via official script (curl https://rclone.org/install.sh)?",
      true,
    );
    if (!install) {
      return false;
    }
    logVerbose("Installing rclone via official script...");
    try {
      // Download and run the install script
      const { stdout } = await exec("curl", ["-s", "https://rclone.org/install.sh"], {
        timeoutMs: 30_000,
      });
      await exec("sudo", ["bash", "-c", stdout], { timeoutMs: 120_000 });
      // Clear cached binary so we find the new one
      cachedRcloneBinary = null;
      return true;
    } catch (err) {
      runtime.error(
        `Failed to install rclone: ${err instanceof Error ? err.message : String(err)}`,
      );
      runtime.error("Try installing manually: https://rclone.org/install/");
      return false;
    }
  }

  runtime.error("rclone not found. Please install manually: https://rclone.org/install/");
  return false;
}

/**
 * Get the default rclone config path.
 */
export function getDefaultRcloneConfigPath(stateDir?: string): string {
  const base = stateDir ?? process.env.CLAWDBOT_STATE_DIR ?? join(homedir(), ".clawdbot");
  return join(base, ".config", "rclone", "rclone.conf");
}

/**
 * Resolve sync config with defaults.
 */
export function resolveSyncConfig(
  config: WorkspaceSyncConfig | undefined,
  workspace: string,
  stateDir?: string,
): {
  provider: WorkspaceSyncProvider;
  remoteName: string;
  remotePath: string;
  localPath: string;
  configPath: string;
  conflictResolve: "newer" | "local" | "remote";
  exclude: string[];
  copySymlinks: boolean;
  interval: number;
  onSessionStart: boolean;
  onSessionEnd: boolean;
} {
  return {
    provider: config?.provider ?? "off",
    remoteName: config?.remoteName ?? DEFAULT_REMOTE_NAME,
    remotePath: config?.remotePath ?? DEFAULT_REMOTE_PATH,
    localPath: join(workspace, config?.localPath ?? DEFAULT_LOCAL_PATH),
    configPath: config?.configPath ?? getDefaultRcloneConfigPath(stateDir),
    conflictResolve: config?.conflictResolve ?? DEFAULT_CONFLICT_RESOLVE,
    exclude: config?.exclude ?? DEFAULT_EXCLUDES,
    copySymlinks: config?.copySymlinks ?? false,
    interval: config?.interval ?? 0,
    onSessionStart: config?.onSessionStart ?? false,
    onSessionEnd: config?.onSessionEnd ?? false,
  };
}

/**
 * Get rclone type string for a provider.
 */
function getRcloneType(provider: WorkspaceSyncProvider): string {
  switch (provider) {
    case "dropbox":
      return "dropbox";
    case "gdrive":
      return "drive";
    case "onedrive":
      return "onedrive";
    case "s3":
      return "s3";
    default:
      return "unknown";
  }
}

/**
 * Generate rclone config content for a provider.
 */
export function generateRcloneConfig(
  provider: WorkspaceSyncProvider,
  remoteName: string,
  token: string,
  options?: {
    dropbox?: { appKey?: string; appSecret?: string };
    s3?: {
      endpoint?: string;
      bucket?: string;
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };
  },
): string {
  const type = getRcloneType(provider);
  let config = `[${remoteName}]\ntype = ${type}\n`;

  if (provider === "dropbox") {
    config += `token = ${token}\n`;
    if (options?.dropbox?.appKey) {
      config += `client_id = ${options.dropbox.appKey}\n`;
    }
    if (options?.dropbox?.appSecret) {
      config += `client_secret = ${options.dropbox.appSecret}\n`;
    }
  } else if (provider === "gdrive") {
    config += `token = ${token}\n`;
  } else if (provider === "onedrive") {
    config += `token = ${token}\n`;
  } else if (provider === "s3") {
    if (options?.s3?.endpoint) {
      config += `endpoint = ${options.s3.endpoint}\n`;
    }
    if (options?.s3?.region) {
      config += `region = ${options.s3.region}\n`;
    }
    if (options?.s3?.accessKeyId) {
      config += `access_key_id = ${options.s3.accessKeyId}\n`;
    }
    if (options?.s3?.secretAccessKey) {
      config += `secret_access_key = ${options.s3.secretAccessKey}\n`;
    }
  }

  return config;
}

/**
 * Write rclone config to disk.
 */
export function writeRcloneConfig(configPath: string, content: string): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, content, { mode: 0o600 });
}

/**
 * Check if rclone config exists and has the remote configured.
 */
export function isRcloneConfigured(configPath: string, remoteName: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const content = readFileSync(configPath, "utf-8");
    return content.includes(`[${remoteName}]`);
  } catch {
    return false;
  }
}

/**
 * Ensure rclone config exists, auto-generating from moltbot.json config if credentials are present.
 * This allows users to configure sync entirely via moltbot.json + env vars without manual rclone setup.
 *
 * @returns true if config exists or was generated, false if credentials are missing
 */
export function ensureRcloneConfigFromConfig(
  syncConfig: WorkspaceSyncConfig | undefined,
  configPath: string,
  remoteName: string,
): boolean {
  // If config already exists with this remote, we're good
  if (isRcloneConfigured(configPath, remoteName)) {
    return true;
  }

  if (!syncConfig?.provider || syncConfig.provider === "off") {
    return false;
  }

  // For Dropbox: need token (appKey/appSecret optional but recommended)
  if (syncConfig.provider === "dropbox") {
    const token = syncConfig.dropbox?.token;
    if (!token) {
      return false;
    }

    logVerbose(`[rclone] Auto-generating config for ${remoteName} from moltbot.json credentials`);

    const configContent = generateRcloneConfig(syncConfig.provider, remoteName, token, {
      dropbox: {
        appKey: syncConfig.dropbox?.appKey,
        appSecret: syncConfig.dropbox?.appSecret,
      },
    });

    writeRcloneConfig(configPath, configContent);
    return true;
  }

  // For S3: need accessKeyId and secretAccessKey
  if (syncConfig.provider === "s3") {
    const { accessKeyId, secretAccessKey, endpoint, bucket, region } = syncConfig.s3 ?? {};
    if (!accessKeyId || !secretAccessKey) {
      return false;
    }

    logVerbose(`[rclone] Auto-generating config for ${remoteName} from moltbot.json credentials`);

    const configContent = generateRcloneConfig(syncConfig.provider, remoteName, "", {
      s3: { endpoint, bucket, region, accessKeyId, secretAccessKey },
    });

    writeRcloneConfig(configPath, configContent);
    return true;
  }

  // Other providers require manual rclone config
  return false;
}

/**
 * Run rclone authorize command (returns the token).
 * This must be run on a machine with a browser.
 */
export async function authorizeRclone(
  provider: WorkspaceSyncProvider,
  appKey?: string,
  appSecret?: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const rcloneBin = await getRcloneBinary();
  const type = getRcloneType(provider);

  const args = ["authorize", type];
  if (appKey && appSecret) {
    args.push(appKey, appSecret);
  }

  try {
    const { stdout, stderr } = await runExec(rcloneBin, args, {
      timeoutMs: 300_000, // 5 minutes for OAuth flow
      maxBuffer: 1_000_000,
    });

    // Extract token from output
    const combined = stdout + stderr;
    const tokenMatch = combined.match(/\{[^}]*"access_token"[^}]*\}/);
    if (tokenMatch) {
      return { ok: true, token: tokenMatch[0] };
    }

    // Try to find JSON object in output
    const jsonMatch = combined.match(
      /Paste the following into your remote machine[\s\S]*?(\{[\s\S]*?\})\s*$/m,
    );
    if (jsonMatch) {
      return { ok: true, token: jsonMatch[1] };
    }

    return { ok: false, error: "Could not extract token from rclone output" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Authorization failed: ${message}` };
  }
}

/**
 * Run bidirectional sync using rclone bisync.
 */
export async function runBisync(params: {
  configPath: string;
  remoteName: string;
  remotePath: string;
  localPath: string;
  conflictResolve: "newer" | "local" | "remote";
  exclude: string[];
  copySymlinks?: boolean;
  resync?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<RcloneSyncResult> {
  const rcloneBin = await getRcloneBinary();

  // Ensure local directory exists
  if (!existsSync(params.localPath)) {
    mkdirSync(params.localPath, { recursive: true });
  }

  const args = [
    "bisync",
    `${params.remoteName}:${params.remotePath}`,
    params.localPath,
    "--config",
    params.configPath,
    "--conflict-resolve",
    params.conflictResolve,
    "--conflict-suffix",
    ".conflict",
  ];

  // Add excludes
  for (const pattern of params.exclude) {
    args.push("--exclude", pattern);
  }

  // Follow symlinks if configured
  if (params.copySymlinks) {
    args.push("--copy-links");
  }

  if (params.resync) {
    args.push("--resync");
  }

  if (params.dryRun) {
    args.push("--dry-run");
  }

  if (params.verbose) {
    args.push("--verbose");
  } else {
    // Suppress NOTICE messages (e.g., symlink warnings) unless verbose
    args.push("--log-level", "WARNING");
  }

  logVerbose(`Running: ${rcloneBin} ${args.join(" ")}`);

  try {
    const { stdout, stderr } = await runExec(rcloneBin, args, {
      timeoutMs: 600_000, // 10 minutes
      maxBuffer: 10_000_000,
    });

    // Parse output for stats
    const combined = stdout + stderr;
    const transferredMatch = combined.match(/Transferred:\s*(\d+)\s*\/\s*(\d+)/);

    return {
      ok: true,
      filesTransferred: transferredMatch ? parseInt(transferredMatch[1], 10) : undefined,
    };
  } catch (err) {
    const errObj = err as { stdout?: string; stderr?: string; message?: string };
    const message =
      errObj.stderr?.trim() || errObj.stdout?.trim() || errObj.message || "Unknown sync error";

    // Check for common errors
    if (message.includes("bisync requires --resync")) {
      return {
        ok: false,
        error: "First sync requires --resync flag to establish baseline",
      };
    }

    return { ok: false, error: message };
  }
}

/**
 * Run one-way sync (copy) from remote to local or vice versa.
 */
export async function runSync(params: {
  configPath: string;
  remoteName: string;
  remotePath: string;
  localPath: string;
  direction: "pull" | "push";
  exclude: string[];
  dryRun?: boolean;
  verbose?: boolean;
}): Promise<RcloneSyncResult> {
  const rcloneBin = await getRcloneBinary();

  // Ensure local directory exists
  if (!existsSync(params.localPath)) {
    mkdirSync(params.localPath, { recursive: true });
  }

  const remote = `${params.remoteName}:${params.remotePath}`;
  const [source, dest] =
    params.direction === "pull" ? [remote, params.localPath] : [params.localPath, remote];

  const args = ["sync", source, dest, "--config", params.configPath];

  for (const pattern of params.exclude) {
    args.push("--exclude", pattern);
  }

  if (params.dryRun) {
    args.push("--dry-run");
  }

  if (params.verbose) {
    args.push("--verbose");
  } else {
    // Suppress NOTICE messages (e.g., symlink warnings) unless verbose
    args.push("--log-level", "WARNING");
  }

  logVerbose(`Running: ${rcloneBin} ${args.join(" ")}`);

  try {
    await runExec(rcloneBin, args, {
      timeoutMs: 600_000,
      maxBuffer: 10_000_000,
    });
    return { ok: true };
  } catch (err) {
    const errObj = err as { stderr?: string; message?: string };
    const message = errObj.stderr?.trim() || errObj.message || "Unknown sync error";
    return { ok: false, error: message };
  }
}

/**
 * List files in remote.
 */
export async function listRemote(params: {
  configPath: string;
  remoteName: string;
  remotePath: string;
}): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  const rcloneBin = await getRcloneBinary();

  try {
    const { stdout } = await runExec(
      rcloneBin,
      ["lsf", `${params.remoteName}:${params.remotePath}`, "--config", params.configPath],
      { timeoutMs: 30_000, maxBuffer: 1_000_000 },
    );

    const files = stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
    return { ok: true, files };
  } catch (err) {
    const errObj = err as { stderr?: string; message?: string };
    const message = errObj.stderr?.trim() || errObj.message || "Unknown error";
    return { ok: false, error: message };
  }
}

/**
 * Check remote connection.
 */
export async function checkRemote(params: {
  configPath: string;
  remoteName: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const rcloneBin = await getRcloneBinary();

  try {
    await runExec(
      rcloneBin,
      ["about", `${params.remoteName}:`, "--config", params.configPath, "--json"],
      { timeoutMs: 30_000, maxBuffer: 100_000 },
    );
    return { ok: true };
  } catch (err) {
    const errObj = err as { stderr?: string; message?: string };
    const message = errObj.stderr?.trim() || errObj.message || "Connection failed";
    return { ok: false, error: message };
  }
}
