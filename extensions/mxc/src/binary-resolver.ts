import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * Resolve the bin/ directory inside the installed @microsoft/mxc-sdk package.
 * Returns the arch-specific subdirectory (x64 or arm64) if available.
 */
function resolveSdkBinDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkPkgPath = require.resolve("@microsoft/mxc-sdk/package.json");
    const sdkRoot = path.dirname(sdkPkgPath);
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const archBin = path.join(sdkRoot, "bin", arch);
    if (fs.existsSync(archBin)) {
      return archBin;
    }
    // Fallback to flat bin/ if no arch subdirectory
    const flatBin = path.join(sdkRoot, "bin");
    if (fs.existsSync(flatBin)) {
      return flatBin;
    }
  } catch {
    // SDK not installed; skip.
  }
  return null;
}

function buildSearchPaths(binary: string, sdkBinDir: string | null): string[] {
  return sdkBinDir ? [path.join(sdkBinDir, binary)] : [];
}

/** SDK-owned search paths for wxc-exec on Windows. */
function wxcSearchPaths(): string[] {
  return buildSearchPaths("wxc-exec.exe", resolveSdkBinDir());
}

function findBinary(searchPaths: string[]): string | null {
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Resolves the MXC executor binary path.
 * @param configOverride Optional user-configured path override.
 * @returns Absolute path to the binary.
 * @throws If the binary cannot be found.
 */
export function resolveMxcBinaryPath(configOverride?: string): string {
  if (configOverride) {
    const resolvedOverride = path.win32.isAbsolute(configOverride)
      ? configOverride
      : path.resolve(configOverride);
    if (!fs.existsSync(resolvedOverride)) {
      throw new Error(`MXC binary not found at configured path: ${configOverride}`);
    }
    return resolvedOverride;
  }

  const binaryName = "wxc-exec.exe";
  const found = findBinary(wxcSearchPaths());

  if (!found) {
    throw new Error(
      `MXC executor "${binaryName}" not found. Install @microsoft/mxc-sdk or set mxcBinaryPath in config.`,
    );
  }
  return found;
}
