import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHROME_VERSION_RE = /\b(\d+)(?:\.\d+){1,3}\b/g;
const BROWSER_VERSION_TIMEOUT_MS = 6000;
const MAC_PLISTBUDDY_TIMEOUT_MS = 800;
const WINDOWS_FILE_METADATA_TIMEOUT_MS = 4000;

export function execBrowserProbe(
  command: string,
  args: string[],
  timeoutMs = 1200,
  maxBuffer = 1024 * 1024,
): string | null {
  try {
    const output = execFileSync(command, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer,
    });
    return normalizeOptionalString(output) ?? null;
  } catch {
    return null;
  }
}

/** Read a browser executable version from platform metadata or a command-line probe. */
export function readBrowserVersion(executablePath: string): string | null {
  if (process.platform === "darwin") {
    const bundleVersion = readMacBundleBrowserVersion(executablePath);
    if (bundleVersion) {
      return bundleVersion;
    }
  }

  if (process.platform === "win32") {
    // Windows GUI browsers do not report `--version` to inherited stdout.
    // Read PE metadata first, then use the install layout only as a safe fallback.
    return readWindowsBrowserVersion(executablePath);
  }

  const output = execBrowserProbe(executablePath, ["--version"], BROWSER_VERSION_TIMEOUT_MS);
  if (!output) {
    return null;
  }
  return output.replace(/\s+/g, " ").trim();
}

function readMacBundleBrowserVersion(executablePath: string): string | null {
  const appBundlePath = resolveMacAppBundlePath(executablePath);
  if (!appBundlePath) {
    return null;
  }
  const plistPath = path.join(appBundlePath, "Contents", "Info.plist");
  return execBrowserProbe(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", plistPath],
    MAC_PLISTBUDDY_TIMEOUT_MS,
  );
}

export const WINDOWS_VERSION_DIR_RE = /^\d+(?:\.\d+){1,3}$/;

function readWindowsBrowserVersion(executablePath: string): string | null {
  // Read the inspected executable's authoritative PE metadata. Pass the path as
  // data so a configured path cannot become part of the PowerShell program.
  const configuredSystemRoot = normalizeOptionalString(process.env.SystemRoot);
  const systemRoot =
    configuredSystemRoot && path.win32.isAbsolute(configuredSystemRoot)
      ? configuredSystemRoot
      : "C:\\Windows";
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const metadataVersion = execBrowserProbe(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.FileVersionInfo]::GetVersionInfo($args[0]).ProductVersion",
      executablePath,
    ],
    WINDOWS_FILE_METADATA_TIMEOUT_MS,
  );
  if (metadataVersion) {
    return metadataVersion.replace(/\s+/g, " ").trim();
  }

  // Standard Chromium installers also keep a versioned child directory. Only
  // trust that layout when it is unambiguous; updates may leave two builds.
  try {
    const versionDirs = fs
      .readdirSync(path.win32.dirname(executablePath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && WINDOWS_VERSION_DIR_RE.test(entry.name));
    return versionDirs.length === 1 ? (versionDirs[0]?.name ?? null) : null;
  } catch {
    return null;
  }
}

function resolveMacAppBundlePath(executablePath: string): string | null {
  const parts = path.normalize(executablePath).split(path.sep);
  const appIndex = parts.findIndex((part) => part.endsWith(".app"));
  if (appIndex < 0) {
    return null;
  }
  return parts.slice(0, appIndex + 1).join(path.sep) || path.sep;
}

/** Parse a major browser version from a raw version string. */
export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  const matches = [...(rawVersion ?? "").matchAll(CHROME_VERSION_RE)];
  const match = matches.at(-1);
  if (!match?.[1]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}
