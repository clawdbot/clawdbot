import fs from "node:fs";
import path from "node:path";
import { getWindowsInstallRoots, getWindowsProgramFilesRoots } from "./windows-install-roots.js";

/**
 * Trust level for system binary resolution.
 * - "strict": Only fixed OS-managed directories. Use for security-critical
 *   binaries like openssl where a compromised binary has high impact.
 * - "standard": Strict dirs plus common local-admin/package-manager
 *   directories appended after system dirs. Use for tool binaries like
 *   ffmpeg that are rarely available via the OS itself.
 */
type SystemBinTrust = "strict" | "standard";

// Unix directories where OS-managed or system-installed binaries live.
// User-writable or package-manager-managed directories are excluded so that
// attacker-planted binaries cannot shadow legitimate system executables.
const UNIX_BASE_TRUSTED_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

// Package-manager directories appended in "standard" trust on macOS.
// These come after strict dirs so OS binaries always take priority.
// Could be acceptable for tooling binaries like ffmpeg but NOT for
// security-critical ones like openssl — callers needing higher
// assurance should stick with "strict".
const DARWIN_STANDARD_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const LINUX_STANDARD_DIRS = ["/usr/local/bin"] as const;

// Windows extensions to probe when searching for executables.
const WIN_PATHEXT = [".exe", ".cmd", ".bat", ".com"] as const;

const resolvedCacheStrict = new Map<string, string>();
const resolvedCacheStandard = new Map<string, string>();

function defaultIsExecutable(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      fs.accessSync(filePath, fs.constants.R_OK);
    } else {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

let isExecutableFn: (filePath: string) => boolean = defaultIsExecutable;

/**
 * Build the trusted-dir list for Windows. Only system-managed directories
 * are included; user-profile paths like %LOCALAPPDATA% are excluded.
 */
function buildWindowsTrustedDirs(): readonly string[] {
  const dirs: string[] = [];
  const { systemRoot } = getWindowsInstallRoots();
  dirs.push(path.win32.join(systemRoot, "System32"));
  dirs.push(path.win32.join(systemRoot, "SysWOW64"));

  for (const programFilesRoot of getWindowsProgramFilesRoots()) {
    // Trust the machine's validated Program Files roots rather than assuming C:.
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL-Win64", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "ffmpeg", "bin"));
  }

  return dirs;
}

/**
 * Build the trusted-dir list for Unix (macOS, Linux, etc.), extending
 * UNIX_BASE_TRUSTED_DIRS with platform/environment-specific paths.
 *
 * Strict: only fixed OS-managed directories.
 *
 * Standard: strict dirs plus platform package-manager directories appended
 * after, so OS binaries always take priority.
 */
function buildUnixTrustedDirs(trust: SystemBinTrust): readonly string[] {
  const dirs: string[] = [...UNIX_BASE_TRUSTED_DIRS];
  const platform = process.platform;

  if (platform === "linux") {
    // Fixed NixOS system profile path. Never derive trust from NIX_PROFILES:
    // env-controlled Nix store/profile entries can be attacker-selected.
    // Callers that intentionally rely on non-default Nix paths must opt in via extraDirs.
    dirs.push("/run/current-system/sw/bin");
    dirs.push("/snap/bin");
  }

  // "standard" trust widens the search for non-security-critical tools in
  // common local-admin/package-manager directories, while keeping strict dirs
  // first so OS binaries always take priority.
  if (trust === "standard") {
    if (platform === "darwin") {
      dirs.push(...DARWIN_STANDARD_DIRS);
    } else if (platform === "linux") {
      dirs.push(...LINUX_STANDARD_DIRS);
    }
  }

  return dirs;
}

let trustedDirsStrict: readonly string[] | null = null;
let trustedDirsStandard: readonly string[] | null = null;

function getTrustedDirs(trust: SystemBinTrust): readonly string[] {
  if (process.platform === "win32") {
    // Windows does not currently widen "standard" beyond the registry-backed
    // system roots; both trust levels intentionally share the same set today.
    trustedDirsStrict ??= buildWindowsTrustedDirs();
    return trustedDirsStrict;
  }
  if (trust === "standard") {
    trustedDirsStandard ??= buildUnixTrustedDirs("standard");
    return trustedDirsStandard;
  }
  trustedDirsStrict ??= buildUnixTrustedDirs("strict");
  return trustedDirsStrict;
}

/**
 * Resolve a binary name to an absolute path by searching only trusted system
 * directories. Returns `null` when the binary is not found. Results are cached
 * for the lifetime of the process.
 *
 * This MUST be used instead of bare binary names in `execFile`/`spawn` calls
 * for internal infrastructure binaries (ffmpeg, ffprobe, openssl, etc.) to
 * prevent PATH-hijack attacks via user-writable directories.
 */
export function resolveSystemBin(
  name: string,
  opts?: { trust?: SystemBinTrust; extraDirs?: readonly string[] },
): string | null {
  const trust = opts?.trust ?? "strict";
  const hasExtra = (opts?.extraDirs?.length ?? 0) > 0;
  const cache = trust === "standard" ? resolvedCacheStandard : resolvedCacheStrict;

  if (!hasExtra) {
    const cached = cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
  }

  const dirs = [...getTrustedDirs(trust), ...(opts?.extraDirs ?? [])];
  const isWin = process.platform === "win32";
  const hasExt = isWin && path.win32.extname(name).length > 0;

  for (const dir of dirs) {
    if (isWin && !hasExt) {
      for (const ext of WIN_PATHEXT) {
        const candidate = path.win32.join(dir, name + ext);
        if (isExecutableFn(candidate)) {
          if (!hasExtra) {
            cache.set(name, candidate);
          }
          return candidate;
        }
      }
    } else {
      const candidate = path.join(dir, name);
      if (isExecutableFn(candidate)) {
        if (!hasExtra) {
          cache.set(name, candidate);
        }
        return candidate;
      }
    }
  }

  return null;
}

/** Visible for tests: the computed trusted directories. */
export function _getTrustedDirs(trust: SystemBinTrust = "strict"): readonly string[] {
  return getTrustedDirs(trust);
}

/** Reset cache and optionally override the executable-check function (for tests). */
export function _resetResolveSystemBin(overrideIsExecutable?: (p: string) => boolean): void {
  resolvedCacheStrict.clear();
  resolvedCacheStandard.clear();
  trustedDirsStrict = null;
  trustedDirsStandard = null;
  isExecutableFn = overrideIsExecutable ?? defaultIsExecutable;
}
