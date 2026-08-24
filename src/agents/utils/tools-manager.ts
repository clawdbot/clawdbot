/**
 * Tool binary manager for agent-side helper commands.
 *
 * Locates or downloads pinned helper binaries such as fd and ripgrep.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import chalk from "chalk";
import { extractArchive } from "../../infra/archive.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { type FileLockOptions, withFileLock } from "../../infra/file-lock.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { APP_NAME, getBinDir } from "../config.js";
import { readProviderJsonResponse } from "../provider-http-errors.js";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 60_000;
const CONTENT_LENGTH_RE = /^\d+$/;
const GITHUB_RELEASE_JSON_MAX_BYTES = 1024 * 1024;
const TOOL_INSTALL_STALE_MS =
  DOWNLOAD_TIMEOUT_MS + ARCHIVE_EXTRACT_TIMEOUT_MS + NETWORK_TIMEOUT_MS + 30_000;
const toolInstallations = new Map<"fd" | "rg", Promise<string>>();
const TOOL_INSTALL_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    // The minimum backoff total is about 234s, beyond the full 220s install bound.
    retries: 480,
    factor: 1.2,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: TOOL_INSTALL_STALE_MS,
  staleRecovery: "remove-if-unchanged",
};

function isOfflineModeEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_OFFLINE);
}

interface ToolConfig {
  name: string;
  repo: string; // GitHub repo (e.g., "sharkdp/fd")
  binaryName: string; // Name of the binary inside the archive
  systemBinaryNames?: string[]; // Alternative system command names to try before downloading
  tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
  getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<"fd" | "rg", ToolConfig> = {
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    systemBinaryNames: ["fd", "fdfind"],
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        if (architecture === "arm64") {
          return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        }
        return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
};

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["--version"], {
      killSignal: "SIGKILL",
      stdio: "pipe",
      timeout: 5_000,
    });
    // Require a clean exit, not just a successful spawn. An installed-but-broken
    // binary (e.g. GLIBC mismatch after a system upgrade, missing shared lib)
    // spawns fine but exits non-zero; without the status check it would be
    // misreported as available and block ensureTool's auto-install fallback.
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

// Get the path to a tool (system-wide or in our tools dir)
function getToolPath(tool: "fd" | "rg"): string | null {
  const config = TOOLS[tool];

  // Check our tools directory first
  const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
  if (existsSync(localPath)) {
    return localPath;
  }

  // Check system PATH - if found, just return the command name (it's in PATH)
  const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
  for (const systemBinaryName of systemBinaryNames) {
    if (commandExists(systemBinaryName)) {
      return systemBinaryName;
    }
  }

  return null;
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
  const guarded = await fetchWithSsrFGuard({
    url: `https://api.github.com/repos/${repo}/releases/latest`,
    timeoutMs: NETWORK_TIMEOUT_MS,
    auditContext: "tools-manager-release-check",
    init: {
      headers: { "User-Agent": `${APP_NAME}-coding-agent` },
    },
  });
  const { response } = guarded;

  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await readProviderJsonResponse<{ tag_name: string }>(response, "GitHub release", {
      maxBytes: GITHUB_RELEASE_JSON_MAX_BYTES,
    });
    return data.tag_name.replace(/^v/, "");
  } finally {
    await guarded.release();
  }
}

async function downloadFile(url: string, dest: string, maxBytes: number): Promise<void> {
  const guarded = await fetchWithSsrFGuard({
    url,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    auditContext: "tools-manager-download",
  });
  const { response } = guarded;

  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`Failed to download: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const rawContentLength = response.headers.get("content-length");
    if (rawContentLength !== null) {
      const contentLength = rawContentLength.trim();
      if (CONTENT_LENGTH_RE.test(contentLength)) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
          await cancelUnreadResponseBody(response);
          throw new Error(`Download exceeds the ${maxBytes}-byte archive limit`);
        }
      }
    }

    const fileStream = createWriteStream(dest);

    let downloadCompleted = false;
    try {
      let downloadedBytes = 0;
      const byteCap = new Transform({
        transform(chunk: Uint8Array, _encoding, callback) {
          downloadedBytes += chunk.byteLength;
          if (downloadedBytes > maxBytes) {
            callback(new Error(`Download exceeded the ${maxBytes}-byte archive limit`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        byteCap,
        fileStream,
      );
      downloadCompleted = true;
    } finally {
      if (!downloadCompleted) {
        rmSync(dest, { force: true });
      }
    }
  } finally {
    await guarded.release();
  }
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === binaryFileName) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  return null;
}

async function extractArchiveSafe(
  archivePath: string,
  extractDir: string,
  assetName: string,
): Promise<void> {
  try {
    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs: ARCHIVE_EXTRACT_TIMEOUT_MS,
      limits: {
        maxArchiveBytes: MAX_ARCHIVE_BYTES,
        maxExtractedBytes: MAX_EXTRACTED_BYTES,
        maxEntries: MAX_ARCHIVE_ENTRIES,
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to extract ${assetName}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
  const config = TOOLS[tool];

  const plat = platform();
  const architecture = arch();

  // Get latest version
  let version = await getLatestVersion(config.repo);
  if (tool === "fd" && plat === "darwin" && architecture === "x64") {
    version = "10.3.0";
  }

  // Get asset name for this platform
  const assetName = config.getAssetName(version, plat, architecture);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }

  // Create tools directory
  mkdirSync(TOOLS_DIR, { recursive: true });

  const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);
  // Keep every installation's archive and extracted files together so parallel
  // processes cannot remove or overwrite another installation's staging files.
  const stagingDir = join(
    TOOLS_DIR,
    `install_tmp_${config.binaryName}_${process.pid}_${randomUUID()}`,
  );
  const archivePath = join(stagingDir, assetName);
  const extractDir = join(stagingDir, "extract");
  mkdirSync(extractDir, { recursive: true });

  try {
    // Download with byte cap so oversized archives are rejected before
    // hitting disk, not just during extraction.
    await downloadFile(downloadUrl, archivePath, MAX_ARCHIVE_BYTES);

    if (assetName.endsWith(".tar.gz") || assetName.endsWith(".zip")) {
      await extractArchiveSafe(archivePath, extractDir, assetName);
    } else {
      throw new Error(`Unsupported archive format: ${assetName}`);
    }

    // Find the binary in extracted files. Some archives contain files directly
    // at root, others nest under a versioned subdirectory.
    const binaryFileName = config.binaryName + binaryExt;
    const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
    const extractedBinaryCandidates = [
      join(extractedDir, binaryFileName),
      join(extractDir, binaryFileName),
    ];
    let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

    if (!extractedBinary) {
      extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
    }

    if (extractedBinary) {
      renameSync(extractedBinary, binaryPath);
    } else {
      throw new Error(
        `Binary not found in archive: expected ${binaryFileName} under ${extractDir}`,
      );
    }

    // Make executable (Unix only)
    if (plat !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return binaryPath;
}

function installTool(tool: "fd" | "rg"): Promise<string> {
  const currentInstallation = toolInstallations.get(tool);
  if (currentInstallation) {
    return currentInstallation;
  }

  const config = TOOLS[tool];
  const binaryPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
  mkdirSync(TOOLS_DIR, { recursive: true });
  const installation = withFileLock(binaryPath, TOOL_INSTALL_LOCK_OPTIONS, async () => {
    const existingPath = getToolPath(tool);
    return existingPath ?? downloadTool(tool);
  });
  toolInstallations.set(tool, installation);
  void installation.then(
    () => {
      if (toolInstallations.get(tool) === installation) {
        toolInstallations.delete(tool);
      }
    },
    () => {
      if (toolInstallations.get(tool) === installation) {
        toolInstallations.delete(tool);
      }
    },
  );
  return installation;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
  fd: "fd",
  rg: "ripgrep",
};

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
export async function ensureTool(tool: "fd" | "rg", silent = false): Promise<string | undefined> {
  const existingPath = getToolPath(tool);
  if (existingPath) {
    return existingPath;
  }

  const config = TOOLS[tool];

  if (isOfflineModeEnabled()) {
    if (!silent) {
      console.log(
        chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`),
      );
    }
    return undefined;
  }

  // On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
  // Users must install via pkg.
  if (platform() === "android") {
    const pkgName = TERMUX_PACKAGES[tool] ?? tool;
    if (!silent) {
      console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
    }
    return undefined;
  }

  // Tool not found - download it
  if (!silent) {
    console.log(chalk.dim(`${config.name} not found. Downloading...`));
  }

  try {
    const path = await installTool(tool);
    if (!silent) {
      console.log(chalk.dim(`${config.name} installed to ${path}`));
    }
    return path;
  } catch (e) {
    if (!silent) {
      console.log(
        chalk.yellow(
          `Failed to download ${config.name}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    return undefined;
  }
}

const testing = {
  downloadFile,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.toolsManagerTestApi")] = {
    testing,
  };
}
