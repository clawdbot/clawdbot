/** Chromium-family executable discovery across supported platforms. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { execBrowserProbe, WINDOWS_VERSION_DIR_RE } from "./chrome.executable-probe.js";
import type { ResolvedBrowserConfig } from "./config.js";

/** Browser executable candidate with product metadata and filesystem path. */
export type BrowserExecutable = {
  kind: "brave" | "canary" | "chromium" | "chrome" | "custom" | "edge";
  path: string;
};

const PLAYWRIGHT_BROWSERS_PATH_ENV = "PLAYWRIGHT_BROWSERS_PATH";
const DEFAULT_WINDOWS_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_WINDOWS_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";

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

function isExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return false;
    }
    // Windows has no POSIX execute bit; a visible regular file preserves its native contract.
    fs.accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
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

  const appPathRaw = execBrowserProbe("/usr/bin/osascript", [
    "-e",
    `POSIX path of (path to application id "${bundleId}")`,
  ]);
  if (!appPathRaw) {
    return null;
  }
  const appPath = appPathRaw.replace(/\/$/, "");
  const exeName = execBrowserProbe("/usr/bin/defaults", [
    "read",
    path.join(appPath, "Contents", "Info"),
    "CFBundleExecutable",
  ]);
  if (!exeName) {
    return null;
  }
  const exePath = path.join(appPath, "Contents", "MacOS", exeName);
  if (!isExecutable(exePath, "darwin")) {
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
  const handlersRaw = execBrowserProbe(
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
    execBrowserProbe("xdg-settings", ["get", "default-web-browser"]) ||
    execBrowserProbe("xdg-mime", ["query", "default", "x-scheme-handler/http"]);
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
  if (!resolved || !isExecutable(resolved, "linux")) {
    return null;
  }
  const exeName = normalizeLowercaseStringOrEmpty(path.posix.basename(resolved));
  if (!CHROMIUM_EXE_NAMES.has(exeName)) {
    return null;
  }
  return { kind: inferKindFromIdentifier(exeName), path: resolved };
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
  if (!isExecutable(exePath, "win32")) {
    return null;
  }
  const directPath = resolveDirectWindowsBrowserExecutable(exePath);
  if (!directPath) {
    return null;
  }
  const exeName = normalizeLowercaseStringOrEmpty(path.win32.basename(directPath));
  if (!CHROMIUM_EXE_NAMES.has(exeName)) {
    return null;
  }
  return { kind: inferKindFromIdentifier(exeName), path: directPath };
}

/** Resolve launchers that hand off to another process into a directly owned browser binary. */
function resolveDirectWindowsBrowserExecutable(executablePath: string): string | null {
  if (normalizeLowercaseStringOrEmpty(path.win32.basename(executablePath)) !== "launcher.exe") {
    return executablePath;
  }
  const installDir = path.win32.dirname(executablePath);
  try {
    const status = JSON.parse(
      fs.readFileSync(path.win32.join(installDir, "installation_status.json"), "utf8"),
    ) as unknown;
    const subfolder =
      status && typeof status === "object" ? Reflect.get(status, "_subfolder") : null;
    if (typeof subfolder !== "string" || !WINDOWS_VERSION_DIR_RE.test(subfolder)) {
      return null;
    }
    const candidate = path.win32.join(installDir, subfolder, "opera.exe");
    return exists(candidate) ? candidate : null;
  } catch {
    return null;
  }
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
  for (const ch of line) {
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
  const resolved = execBrowserProbe("which", [cleaned], 800);
  return resolved ? resolved.trim() : null;
}

function readWindowsProgId(): string | null {
  const output = execBrowserProbe("reg", [
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
  const output = execBrowserProbe("reg", ["query", key, "/ve"]);
  if (!output) {
    return null;
  }
  const match = output.match(/REG_\w+\s+(.+)$/im);
  return normalizeOptionalString(match?.[1]) ?? null;
}

function resolveWindowsBrowserInstallRoots() {
  return {
    localAppData:
      normalizeOptionalString(process.env.LOCALAPPDATA) ??
      path.win32.join(os.homedir(), "AppData", "Local"),
    programFiles:
      normalizeOptionalString(process.env.ProgramFiles) ?? DEFAULT_WINDOWS_PROGRAM_FILES,
    // Must use bracket notation: variable name contains parentheses.
    programFilesX86:
      normalizeOptionalString(process.env["ProgramFiles(x86)"]) ??
      DEFAULT_WINDOWS_PROGRAM_FILES_X86,
  };
}

function expandWindowsEnvVars(value: string): string {
  const installRoots = resolveWindowsBrowserInstallRoots();
  const installRootByEnvName: Record<string, string> = {
    localappdata: installRoots.localAppData,
    programfiles: installRoots.programFiles,
    "programfiles(x86)": installRoots.programFilesX86,
  };
  return value.replace(/%([^%]+)%/g, (_match, name) => {
    const key = normalizeOptionalString(name);
    if (!key) {
      return _match;
    }
    return (
      normalizeOptionalString(process.env[key]) ??
      installRootByEnvName[key.toLowerCase()] ??
      `%${key}%`
    );
  });
}

function extractWindowsExecutablePath(command: string): string | null {
  const quoted = command.match(/"([^"]+\.exe)"/i);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const unquoted = command.match(/^\s*(\S+\.exe)(?:\s|$)/i);
  if (unquoted?.[1]) {
    return unquoted[1];
  }
  return null;
}

function findFirstExecutable(
  candidates: Array<BrowserExecutable>,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (isExecutable(candidate.path, platform)) {
      return candidate;
    }
  }

  return null;
}

function findFirstChromeExecutable(
  candidates: string[],
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (isExecutable(candidate, platform)) {
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

function findPlaywrightChromiumExecutableCandidatesLinux(): Array<BrowserExecutable> {
  const candidates: Array<BrowserExecutable> = [];
  for (const browserPath of getPlaywrightBrowserCachePaths()) {
    for (const entry of readSortedDirNames(browserPath)) {
      if (!entry.startsWith("chromium-")) {
        continue;
      }
      for (const linuxDir of ["chrome-linux64", "chrome-linux"]) {
        candidates.push({
          kind: "chromium",
          path: path.join(browserPath, entry, linuxDir, "chrome"),
        });
      }
    }
  }
  return candidates;
}

function getPlaywrightBrowserCachePaths(): string[] {
  const configured = normalizeOptionalString(process.env[PLAYWRIGHT_BROWSERS_PATH_ENV]);
  const candidates = [
    configured && configured !== "0" ? configured : null,
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function readSortedDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

/** Find the best Chromium-family executable on macOS. */
function findChromeExecutableMac(): BrowserExecutable | null {
  const applications: Array<[BrowserExecutable["kind"], string]> = [
    ["chrome", "Google Chrome"],
    ["brave", "Brave Browser"],
    ["edge", "Microsoft Edge"],
    ["chromium", "Chromium"],
    ["canary", "Google Chrome Canary"],
  ];
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  const candidates = applications.flatMap(([kind, name]) =>
    roots.map((root) => ({
      kind,
      path: path.join(root, `${name}.app`, "Contents", "MacOS", name),
    })),
  );

  return findFirstExecutable(candidates, "darwin");
}

function findGoogleChromeExecutableMac(): BrowserExecutable | null {
  return findFirstChromeExecutable(
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      path.join(
        os.homedir(),
        "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    ],
    "darwin",
  );
}

/** Find the best Chromium-family executable on Linux. */
function findChromeExecutableLinux(): BrowserExecutable | null {
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
    ...findPlaywrightChromiumExecutableCandidatesLinux(),
  ];

  return findFirstExecutable(candidates, "linux");
}

function findGoogleChromeExecutableLinux(): BrowserExecutable | null {
  return findFirstChromeExecutable(
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome-beta",
      "/usr/bin/google-chrome-unstable",
      "/opt/google/chrome/chrome",
      "/snap/bin/google-chrome",
    ],
    "linux",
  );
}

/** Find the best Chromium-family executable on Windows. */
function findChromeExecutableWindows(): BrowserExecutable | null {
  const { localAppData, programFiles, programFilesX86 } = resolveWindowsBrowserInstallRoots();
  const browsers: Array<[BrowserExecutable["kind"], ...string[]]> = [
    ["chrome", "Google", "Chrome", "Application", "chrome.exe"],
    ["brave", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ["edge", "Microsoft", "Edge", "Application", "msedge.exe"],
    ["chromium", "Chromium", "Application", "chrome.exe"],
    ["canary", "Google", "Chrome SxS", "Application", "chrome.exe"],
  ];
  const candidates: BrowserExecutable[] = browsers.map(([kind, ...segments]) => ({
    kind,
    path: path.win32.join(localAppData, ...segments),
  }));

  for (const [kind, ...segments] of browsers.slice(0, 3)) {
    for (const root of [programFiles, programFilesX86]) {
      candidates.push({ kind, path: path.win32.join(root, ...segments) });
    }
  }

  return findFirstExecutable(candidates, "win32");
}

function findGoogleChromeExecutableWindows(): BrowserExecutable | null {
  const { localAppData, programFiles, programFilesX86 } = resolveWindowsBrowserInstallRoots();
  const joinWin = path.win32.join;
  const candidates = [
    joinWin(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    joinWin(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
    joinWin(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    joinWin(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ];

  return findFirstChromeExecutable(candidates, "win32");
}

/** Resolve the Google Chrome executable for a named platform when available. */
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

/** Resolve the preferred Chromium-family executable for a platform. */
export function resolveBrowserExecutableForPlatform(
  resolved: ResolvedBrowserConfig,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (resolved.executablePath) {
    if (!exists(resolved.executablePath)) {
      throw new Error(`browser.executablePath not found: ${resolved.executablePath}`);
    }
    const directPath =
      platform === "win32"
        ? resolveDirectWindowsBrowserExecutable(resolved.executablePath)
        : resolved.executablePath;
    if (!directPath) {
      throw new Error(
        `browser.executablePath must point to the browser executable, not a handoff launcher: ${resolved.executablePath}`,
      );
    }
    return { kind: "custom", path: directPath };
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
