import { type SpawnSyncReturns, spawnSync } from "node:child_process";
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
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import chalk from "chalk";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { APP_NAME, getBinDir } from "../config.js";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
  const value = process.env.OPENCLAW_OFFLINE;
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
  name: string;
  repo: string; // GitHub repo (e.g., "sharkdp/fd")
  binaryName: string; // Name of the binary inside the archive
  systemBinaryNames?: string[]; // Alternative system command names to try before downloading
  tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
  getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
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
    const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    // Check for ENOENT error (command not found)
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
  const config = TOOLS[tool];
  if (!config) {
    return null;
  }

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
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = (await response.json()) as { tag_name: string };
    return data.tag_name.replace(/^v/, "");
  } finally {
    await guarded.release();
  }
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
  const guarded = await fetchWithSsrFGuard({
    url,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    auditContext: "tools-manager-download",
  });
  const { response } = guarded;

  try {
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const fileStream = createWriteStream(dest);
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), fileStream);
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

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
  if (result.error?.message) {
    return result.error.message;
  }
  const stderr = result.stderr?.toString().trim();
  if (stderr) {
    return stderr;
  }
  const stdout = result.stdout?.toString().trim();
  if (stdout) {
    return stdout;
  }
  return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (!result.error && result.status === 0) {
    return null;
  }
  return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
  const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
  if (failure) {
    throw new Error(`Failed to extract ${assetName}: ${failure}`);
  }
}

function getWindowsTarCommand(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot) {
    const systemTar = join(systemRoot, "System32", "tar.exe");
    if (existsSync(systemTar)) {
      return systemTar;
    }
  }
  return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
  const failures: string[] = [];

  if (platform() === "win32") {
    // Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
    // System32 binary over Git Bash's GNU tar, which does not handle zip archives.
    const tarFailure = runExtractionCommand(getWindowsTarCommand(), [
      "xf",
      archivePath,
      "-C",
      extractDir,
    ]);
    if (!tarFailure) {
      return;
    }
    failures.push(tarFailure);

    const script =
      "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershellFailure = runExtractionCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      archivePath,
      extractDir,
    ]);
    if (!powershellFailure) {
      return;
    }
    failures.push(powershellFailure);
  } else {
    const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
    if (!unzipFailure) {
      return;
    }
    failures.push(unzipFailure);

    const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
    if (!tarFailure) {
      return;
    }
    failures.push(tarFailure);
  }

  throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
  const config = TOOLS[tool];
  if (!config) {
    throw new Error(`Unknown tool: ${tool}`);
  }

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
  const archivePath = join(TOOLS_DIR, assetName);
  const binaryExt = plat === "win32" ? ".exe" : "";
  const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

  // Download
  await downloadFile(downloadUrl, archivePath);

  // Extract into a unique temp directory. fd and rg downloads can run concurrently
  // during startup, so sharing a fixed directory causes races.
  const extractDir = join(
    TOOLS_DIR,
    `extract_tmp_${config.binaryName}_${process.pid}_${randomUUID()}`,
  );
  mkdirSync(extractDir, { recursive: true });

  try {
    if (assetName.endsWith(".tar.gz")) {
      extractTarGzArchive(archivePath, extractDir, assetName);
    } else if (assetName.endsWith(".zip")) {
      extractZipArchive(archivePath, extractDir, assetName);
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
    // Cleanup
    rmSync(archivePath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  return binaryPath;
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
  if (!config) {
    return undefined;
  }

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
    const path = await downloadTool(tool);
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
