import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";
const WINDOWS_NT_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
const WINDOWS_CURRENT_VERSION_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";
const REG_QUERY_TIMEOUT_MS = 5_000;

type QueryRegistryValue = (key: string, valueName: string) => string | null;
type IsReadableFile = (filePath: string) => boolean;

type WindowsInstallRootsTestOverrides = {
  queryRegistryValue?: QueryRegistryValue;
  isReadableFile?: IsReadableFile;
};

type WindowsInstallRoots = {
  systemRoot: string;
  programFiles: string;
  programFilesX86: string;
  programW6432: string | null;
};

let queryRegistryValueFn: QueryRegistryValue = defaultQueryRegistryValue;
let isReadableFileFn: IsReadableFile = defaultIsReadableFile;
let cachedProcessInstallRoots: WindowsInstallRoots | null = null;

function defaultIsReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function trimTrailingSeparators(value: string): string {
  const parsed = path.win32.parse(value);
  let trimmed = value;
  while (trimmed.length > parsed.root.length && /[\\/]/.test(trimmed.at(-1) ?? "")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Windows install roots should be local absolute directories, not drive-relative
 * paths, UNC shares, or PATH-like lists that could widen trust unexpectedly.
 */
export function normalizeWindowsInstallRoot(raw: string | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes(";")
  ) {
    return null;
  }
  const normalized = trimTrailingSeparators(path.win32.normalize(trimmed));
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
    return null;
  }
  if (normalized.length <= parsed.root.length) {
    return null;
  }
  return normalized;
}

function getEnvValueCaseInsensitive(
  env: Record<string, string | undefined>,
  expectedKey: string,
): string | undefined {
  const direct = env[expectedKey];
  if (direct !== undefined) {
    return direct;
  }
  const upper = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === upper);
  return actualKey ? env[actualKey] : undefined;
}

function getWindowsRegExeCandidates(): readonly string[] {
  return [path.win32.join(DEFAULT_WINDOWS_SYSTEM_ROOT, "System32", "reg.exe")];
}

function locateWindowsRegExe(): string | null {
  for (const candidate of getWindowsRegExeCandidates()) {
    if (isReadableFileFn(candidate)) {
      return candidate;
    }
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRegQueryValue(stdout: string, valueName: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegex(valueName)}\\s+REG_[A-Z0-9_]+\\s+(.+)$`, "im");
  const match = stdout.match(pattern);
  return match?.[1]?.trim() || null;
}

function runRegQuery(
  regExe: string,
  key: string,
  valueName: string,
  use64BitView: boolean,
): string {
  const args = ["query", key, "/v", valueName];
  if (use64BitView) {
    args.push("/reg:64");
  }
  return execFileSync(regExe, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: REG_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
}

function defaultQueryRegistryValue(key: string, valueName: string): string | null {
  const regExe = locateWindowsRegExe();
  if (!regExe) {
    return null;
  }

  for (const use64BitView of [true, false]) {
    try {
      const stdout = runRegQuery(regExe, key, valueName, use64BitView);
      const parsed = parseRegQueryValue(stdout, valueName);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Keep trying alternate registry views or fallbacks below.
    }
  }
  return null;
}

function getRegistryInstallRoots(): Partial<WindowsInstallRoots> {
  return {
    systemRoot:
      normalizeWindowsInstallRoot(
        queryRegistryValueFn(WINDOWS_NT_CURRENT_VERSION_KEY, "SystemRoot") ?? undefined,
      ) ?? undefined,
    programFiles:
      normalizeWindowsInstallRoot(
        queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir") ?? undefined,
      ) ?? undefined,
    programFilesX86:
      normalizeWindowsInstallRoot(
        queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramFilesDir (x86)") ?? undefined,
      ) ?? undefined,
    programW6432:
      normalizeWindowsInstallRoot(
        queryRegistryValueFn(WINDOWS_CURRENT_VERSION_KEY, "ProgramW6432Dir") ?? undefined,
      ) ?? undefined,
  };
}

function buildWindowsInstallRoots(
  env: Record<string, string | undefined>,
  useRegistryRoots: boolean,
): WindowsInstallRoots {
  const registryRoots = useRegistryRoots ? getRegistryInstallRoots() : {};
  const envProgramW6432 = normalizeWindowsInstallRoot(
    getEnvValueCaseInsensitive(env, "ProgramW6432"),
  );
  const programW6432 = registryRoots.programW6432 ?? envProgramW6432 ?? null;

  return {
    systemRoot:
      registryRoots.systemRoot ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
      DEFAULT_WINDOWS_SYSTEM_ROOT,
    programFiles:
      registryRoots.programFiles ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles")) ??
      programW6432 ??
      DEFAULT_PROGRAM_FILES,
    programFilesX86:
      registryRoots.programFilesX86 ??
      normalizeWindowsInstallRoot(getEnvValueCaseInsensitive(env, "ProgramFiles(x86)")) ??
      DEFAULT_PROGRAM_FILES_X86,
    programW6432,
  };
}

export function getWindowsInstallRoots(
  env: Record<string, string | undefined> = process.env,
): WindowsInstallRoots {
  if (env === process.env) {
    cachedProcessInstallRoots ??= buildWindowsInstallRoots(env, true);
    return cachedProcessInstallRoots;
  }
  return buildWindowsInstallRoots(env, false);
}

export function getWindowsProgramFilesRoots(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const roots = getWindowsInstallRoots(env);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [roots.programW6432, roots.programFiles, roots.programFilesX86]) {
    if (!value) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function _resetWindowsInstallRootsForTests(
  overrides: WindowsInstallRootsTestOverrides = {},
): void {
  queryRegistryValueFn = overrides.queryRegistryValue ?? defaultQueryRegistryValue;
  isReadableFileFn = overrides.isReadableFile ?? defaultIsReadableFile;
  cachedProcessInstallRoots = null;
}

export const _private = {
  getWindowsRegExeCandidates,
  locateWindowsRegExe,
};
