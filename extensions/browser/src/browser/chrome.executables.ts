import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedBrowserConfig } from "./config.js";

export type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};

const CHROME_VERSION_RE = /\b(\d+)(?:\.\d+){1,3}\b/g;

const CHROMIUM_BUNDLE_IDS = new Set([
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.canary",
  "com.google.Chrome.dev",
  "com.brave.Browser",
  "com.brave.Browser.beta",
  "com.brave.Browser.nightly",
  "com.microsoft.Edge",
  "com.microsoft.EdgeBeta",
  "com.microsoft.EdgeDev",
  "com.microsoft.EdgeCanary",
  // Edge LaunchServices IDs (used in macOS default browser registration —
  // these differ from CFBundleIdentifier and are what plutil returns)
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.beta",
  "com.microsoft.edgemac.dev",
  "com.microsoft.edgemac.canary",
  "org.chromium.Chromium",
  "com.vivaldi.Vivaldi",
  "com.operasoftware.Opera",
  "com.operasoftware.OperaGX",
  "com.yandex.desktop.yandex-browser",
  "company.thebrowser.Browser", // Arc
]);

const CHROMIUM_DESKTOP_IDS = new Set([
  "google-chrome.desktop",
  "google-chrome-beta.desktop",
  "google-chrome-unstable.desktop",
  "brave-browser.desktop",
  "microsoft-edge.desktop",
  "microsoft-edge-beta.desktop",
  "microsoft-edge-dev.desktop",
  "microsoft-edge-canary.desktop",
  "chromium.desktop",
  "chromium-browser.desktop",
  "vivaldi.desktop",
  "vivaldi-stable.desktop",
  "opera.desktop",
  "opera-gx.desktop",
  "yandex-browser.desktop",
  "org.chromium.Chromium.desktop",
]);

const CHROMIUM_EXE_NAMES = new Set([
  "chrome.exe",
  "msedge.exe",
  "brave.exe",
  "brave-browser.exe",
  "chromium.exe",
  "vivaldi.exe",
  "opera.exe",
  "launcher.exe",
  "yandex.exe",
  "yandexbrowser.exe",
  // mac/linux names
  "google chrome",
  "google chrome canary",
  "brave browser",
  "microsoft edge",
  "chromium",
  "chrome",
  "brave",
  "msedge",
  "brave-browser",
  "google-chrome",
  "google-chrome-stable",
  "google-chrome-beta",
  "google-chrome-unstable",
  "microsoft-edge",
  "microsoft-edge-beta",
  "microsoft-edge-dev",
  "microsoft-edge-canary",
  "chromium-browser",
  "vivaldi",
  "vivaldi-stable",
  "opera",
  "opera-stable",
  "opera-gx",
  "yandex-browser",
]);

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function execText(
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

function inferKindFromIdentifier(identifier: string): BrowserExecutable["kind"] {
  const id = normalizeLowercaseStringOrEmpty(identifier);
  if (id.includes("brave")) {
    return "brave";
  }
  if (id.includes("edge")) {
    return "edge";
  }
  if (id.includes("chromium")) {
    return "chromium";
  }
  if (id.includes("canary")) {
    return "canary";
  }
  if (
    id.includes("opera") ||
    id.includes("vivaldi") ||
    id.includes("yandex") ||
    id.includes("thebrowser")
  ) {
    return "chromium";
  }
  return "chrome";
}

function inferKindFromExecutableName(name: string): BrowserExecutable["kind"] {
  const lower = normalizeLowercaseStringOrEmpty(name);
  if (lower.includes("brave")) {
    return "brave";
  }
  if (lower.includes("edge") || lower.includes("msedge")) {
    return "edge";
  }
  if (lower.includes("chromium")) {
    return "chromium";
  }
  if (lower.includes("canary") || lower.includes("sxs")) {
    return "canary";
  }
  if (lower.includes("opera") || lower.includes("vivaldi") || lower.includes("yandex")) {
    return "chromium";
  }
  return "chrome";
}

function detectDefaultChromiumExecutable(platform: NodeJS.Platform): BrowserExecutable | null {
  if (platform === "darwin") {
    return detectDefaultChromiumExecutableMac();
  }
  if (platform === "linux") {
    return detectDefaultChromiumExecutableLinux();
  }
  if (platform === "win32") {
    return detectDefaultChromiumExecutableWindows();
  }
  return null;
}

function detectDefaultChromiumExecutableMac(): BrowserExecutable | null {
  const bundleId = detectDefaultBrowserBundleIdMac();
  if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId)) {
    return null;
  }

  const appPathRaw = execText("/usr/bin/osascript", [
    "-e",
    `POSIX path of (path to application id "${bundleId}")`,
  ]);
  if (!appPathRaw) {
    return null;
  }
  const appPath = appPathRaw.replace(/\/$/, "");
  const exeName = execText("/usr/bin/defaults", [
    "read",
    path.join(appPath, "Contents", "Info"),
    "CFBundleExecutable",
  ]);
  if (!exeName) {
    return null;
  }
  const exePath = path.join(appPath, "Contents", "MacOS", exeName);
  if (!exists(exePath)) {
    return null;
  }
  return { kind: inferKindFromIdentifier(bundleId), path: exePath };
}

function detectDefaultBrowserBundleIdMac(): string | null {
  const plistPath = path.join(
    os.homedir(),
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  );
  if (!exists(plistPath)) {
    return null;
  }
  const handlersRaw = execText(
    "/usr/bin/plutil",
    ["-extract", "LSHandlers", "json", "-o", "-", "--", plistPath],
    2000,
    5 * 1024 * 1024,
  );
  if (!handlersRaw) {
    return null;
  }
  let handlers: unknown;
  try {
    handlers = JSON.parse(handlersRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(handlers)) {
    return null;
  }

  const resolveScheme = (scheme: string) => {
    let candidate: string | null = null;
    for (const entry of handlers) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.LSHandlerURLScheme !== scheme) {
        continue;
      }
      const role =
        (typeof record.LSHandlerRoleAll === "string" && record.LSHandlerRoleAll) ||
        (typeof record.LSHandlerRoleViewer === "string" && record.LSHandlerRoleViewer) ||
        null;
      if (role) {
        candidate = role;
      }
    }
    return candidate;
  };

  return resolveScheme("http") ?? resolveScheme("https");
}

function detectDefaultChromiumExecutableLinux(): BrowserExecutable | null {
  const desktopId =
    execText("xdg-settings", ["get", "default-web-browser"]) ||
    execText("xdg-mime", ["query", "default", "x-scheme-handler/http"]);
  if (!desktopId) {
    return null;
  }
  const trimmed = desktopId.trim();
  if (!CHROMIUM_DESKTOP_IDS.has(trimmed)) {
    return null;
  }
  const desktopPath = findDesktopFilePath(trimmed);
  if (!desktopPath) {
    return null;
  }
  const execLine = readDesktopExecLine(desktopPath);
  if (!execLine) {
    return null;
  }
  const command = extractExecutableFromExecLine(execLine);
  if (!command) {
    return null;
  }
  const resolved = resolveLinuxExecutablePath(command);
  if (!resolved) {
    return null;
  }
  const exeName = normalizeLowercaseStringOrEmpty(path.posix.basename(resolved));
  if (!CHROMIUM_EXE_NAMES.has(exeName)) {
    return null;
  }
  return { kind: inferKindFromExecutableName(exeName), path: resolved };
}

function detectDefaultChromiumExecutableWindows(): BrowserExecutable | null {
  const progId = readWindowsProgId();
  const command =
    (progId ? readWindowsCommandForProgId(progId) : null) || readWindowsCommandForProgId("http");
  if (!command) {
    return null;
  }
  const expanded = expandWindowsEnvVars(command);
  const exePath = extractWindowsExecutablePath(expanded);
  if (!exePath) {
    return null;
  }
  if (!exists(exePath)) {
    return null;
  }
  const exeName = normalizeLowercaseStringOrEmpty(path.win32.basename(exePath));
  if (!CHROMIUM_EXE_NAMES.has(exeName)) {
    return null;
  }
  return { kind: inferKindFromExecutableName(exeName), path: exePath };
}

function findDesktopFilePath(desktopId: string): string | null {
  const candidates = [
    path.join(os.homedir(), ".local", "share", "applications", desktopId),
    path.join("/usr/local/share/applications", desktopId),
    path.join("/usr/share/applications", desktopId),
    path.join("/var/lib/snapd/desktop/applications", desktopId),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readDesktopExecLine(desktopPath: string): string | null {
  try {
    const raw = fs.readFileSync(desktopPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("Exec=")) {
        return line.slice("Exec=".length).trim();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function extractExecutableFromExecLine(execLine: string): string | null {
  const tokens = splitExecLine(execLine);
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (token === "env") {
      continue;
    }
    if (token.includes("=") && !token.startsWith("/") && !token.includes("\\")) {
      continue;
    }
    return token.replace(/^["']|["']$/g, "");
  }
  return null;
}

function splitExecLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && (!inQuotes || ch === quoteChar)) {
      if (inQuotes) {
        inQuotes = false;
        quoteChar = "";
      } else {
        inQuotes = true;
        quoteChar = ch;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function resolveLinuxExecutablePath(command: string): string | null {
  const cleaned = command.trim().replace(/%[a-zA-Z]/g, "");
  if (!cleaned) {
    return null;
  }
  if (cleaned.startsWith("/")) {
    return cleaned;
  }
  const resolved = execText("which", [cleaned], 800);
  return resolved ? resolved.trim() : null;
}

function readWindowsProgId(): string | null {
  const output = execText("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
    "/v",
    "ProgId",
  ]);
  if (!output) {
    return null;
  }
  const match = output.match(/ProgId\s+REG_\w+\s+(.+)$/im);
  return match?.[1]?.trim() || null;
}

function readWindowsCommandForProgId(progId: string): string | null {
  const key =
    progId === "http"
      ? "HKCR\\http\\shell\\open\\command"
      : `HKCR\\${progId}\\shell\\open\\command`;
  const output = execText("reg", ["query", key, "/ve"]);
  if (!output) {
    return null;
  }
  const match = output.match(/REG_\w+\s+(.+)$/im);
  return normalizeOptionalString(match?.[1]) ?? null;
}

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name) => {
    const key = normalizeOptionalString(name) ?? "";
    return key ? (process.env[key] ?? `%${key}%`) : _match;
  });
}

function extractWindowsExecutablePath(command: string): string | null {
  const quoted = command.match(/"([^"]+\\.exe)"/i);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const unquoted = command.match(/([^\\s]+\\.exe)/i);
  if (unquoted?.[1]) {
    return unquoted[1];
  }
  return null;
}

function findFirstExecutable(candidates: Array<BrowserExecutable>): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return candidate;
    }
  }

  return null;
}

function findFirstChromeExecutable(candidates: string[]): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      const normalizedPath = normalizeLowercaseStringOrEmpty(candidate);
      return {
        kind:
          normalizedPath.includes("beta") ||
          normalizedPath.includes("canary") ||
          normalizedPath.includes("sxs") ||
          normalizedPath.includes("unstable")
            ? "canary"
            : "chrome",
        path: candidate,
      };
    }
  }

  return null;
}

export function findChromeExecutableMac(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    },
    {
      kind: "brave",
      path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
    {
      kind: "brave",
      path: path.join(os.homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
    },
    {
      kind: "edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    {
      kind: "edge",
      path: path.join(
        os.homedir(),
        "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ),
    },
    {
      kind: "chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      kind: "chromium",
      path: path.join(os.homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    },
    {
      kind: "canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
    {
      kind: "canary",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    },
  ];

  return findFirstExecutable(candidates);
}

function findGoogleChromeExecutableMac(): BrowserExecutable | null {
  return findFirstChromeExecutable([
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    path.join(
      os.homedir(),
      "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ),
  ]);
}

export function findChromeExecutableLinux(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chrome", path: "/usr/bin/chrome" },
    { kind: "chrome", path: "/opt/google/chrome/chrome" },
    { kind: "brave", path: "/usr/bin/brave-browser" },
    { kind: "brave", path: "/usr/bin/brave-browser-stable" },
    { kind: "brave", path: "/usr/bin/brave" },
    { kind: "brave", path: "/snap/bin/brave" },
    { kind: "brave", path: "/opt/brave.com/brave/brave-browser" },
    { kind: "edge", path: "/usr/bin/microsoft-edge" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-stable" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/usr/lib/chromium/chromium" },
    { kind: "chromium", path: "/usr/lib/chromium-browser/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
  ];

  return findFirstExecutable(candidates);
}

function findGoogleChromeExecutableLinux(): BrowserExecutable | null {
  return findFirstChromeExecutable([
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome-beta",
    "/usr/bin/google-chrome-unstable",
    "/opt/google/chrome/chrome",
    "/snap/bin/google-chrome",
  ]);
}

export function findChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  // Must use bracket notation: variable name contains parentheses.
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const joinWin = path.win32.join;
  const candidates: Array<BrowserExecutable> = [];

  if (localAppData) {
    // Chrome (user install)
    candidates.push({
      kind: "chrome",
      path: joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    });
    // Brave (user install)
    candidates.push({
      kind: "brave",
      path: joinWin(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    });
    // Edge (user install)
    candidates.push({
      kind: "edge",
      path: joinWin(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    });
    // Chromium (user install)
    candidates.push({
      kind: "chromium",
      path: joinWin(localAppData, "Chromium", "Application", "chrome.exe"),
    });
    // Chrome Canary (user install)
    candidates.push({
      kind: "canary",
      path: joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
    });
  }

  // Chrome (system install, 64-bit)
  candidates.push({
    kind: "chrome",
    path: joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
  });
  // Chrome (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "chrome",
    path: joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  });
  // Brave (system install, 64-bit)
  candidates.push({
    kind: "brave",
    path: joinWin(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  });
  // Brave (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "brave",
    path: joinWin(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  });
  // Edge (system install, 64-bit)
  candidates.push({
    kind: "edge",
    path: joinWin(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  });
  // Edge (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "edge",
    path: joinWin(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  });

  return findFirstExecutable(candidates);
}

function findGoogleChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const joinWin = path.win32.join;
  const candidates: string[] = [];

  if (localAppData) {
    candidates.push(joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
    candidates.push(joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"));
  }

  candidates.push(joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
  candidates.push(joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));

  return findFirstChromeExecutable(candidates);
}

export function resolveGoogleChromeExecutableForPlatform(
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (platform === "darwin") {
    return findGoogleChromeExecutableMac();
  }
  if (platform === "linux") {
    return findGoogleChromeExecutableLinux();
  }
  if (platform === "win32") {
    return findGoogleChromeExecutableWindows();
  }
  return null;
}

export function readBrowserVersion(executablePath: string): string | null {
  const output = execText(executablePath, ["--version"], 2000);
  if (!output) {
    return null;
  }
  return output.replace(/\s+/g, " ").trim();
}

export function parseBrowserMajorVersion(rawVersion: string | null | undefined): number | null {
  const matches = [...(rawVersion ?? "").matchAll(CHROME_VERSION_RE)];
  const match = matches.at(-1);
  if (!match?.[1]) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

export function resolveBrowserExecutableForPlatform(
  resolved: ResolvedBrowserConfig,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (resolved.executablePath) {
    if (!exists(resolved.executablePath)) {
      throw new Error(`browser.executablePath not found: ${resolved.executablePath}`);
    }
    return { kind: "custom", path: resolved.executablePath };
  }

  const detected = detectDefaultChromiumExecutable(platform);
  if (detected) {
    return detected;
  }

  if (platform === "darwin") {
    return findChromeExecutableMac();
  }
  if (platform === "linux") {
    return findChromeExecutableLinux();
  }
  if (platform === "win32") {
    return findChromeExecutableWindows();
  }
  return null;
}
