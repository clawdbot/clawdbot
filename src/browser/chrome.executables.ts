import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ResolvedBrowserConfig } from "./config.js";

export type BrowserExecutable = {
  kind: "canary" | "chromium" | "chrome" | "custom";
  path: string;
};

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findFirstExecutable(
  candidates: Array<BrowserExecutable>,
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate;
  }

  return null;
}

export function findChromeExecutableMac(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
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
    {
      kind: "chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      kind: "chromium",
      path: path.join(
        os.homedir(),
        "Applications/Chromium.app/Contents/MacOS/Chromium",
      ),
    },
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableLinux(): BrowserExecutable | null {
  const candidates: Array<BrowserExecutable> = [
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
    { kind: "chrome", path: "/usr/bin/chrome" },
  ];

  return findFirstExecutable(candidates);
}

export function findChromeExecutableWindows(): BrowserExecutable | null {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  // Must use bracket notation: variable name contains parentheses
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  const joinWin = path.win32.join;
  const candidates: Array<BrowserExecutable> = [];

  if (localAppData) {
    // Chrome Canary (user install)
    candidates.push({
      kind: "canary",
      path: joinWin(
        localAppData,
        "Google",
        "Chrome SxS",
        "Application",
        "chrome.exe",
      ),
    });
    // Chromium (user install)
    candidates.push({
      kind: "chromium",
      path: joinWin(localAppData, "Chromium", "Application", "chrome.exe"),
    });
    // Chrome (user install)
    candidates.push({
      kind: "chrome",
      path: joinWin(
        localAppData,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    });
  }

  // Chrome (system install, 64-bit)
  candidates.push({
    kind: "chrome",
    path: joinWin(
      programFiles,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  });
  // Chrome (system install, 32-bit on 64-bit Windows)
  candidates.push({
    kind: "chrome",
    path: joinWin(
      programFilesX86,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  });

  return findFirstExecutable(candidates);
}

export function resolveBrowserExecutableForPlatform(
  resolved: ResolvedBrowserConfig,
  platform: NodeJS.Platform,
): BrowserExecutable | null {
  if (resolved.executablePath) {
    if (!exists(resolved.executablePath)) {
      throw new Error(
        `browser.executablePath not found: ${resolved.executablePath}`,
      );
    }
    return { kind: "custom", path: resolved.executablePath };
  }

  if (platform === "darwin") return findChromeExecutableMac();
  if (platform === "linux") return findChromeExecutableLinux();
  if (platform === "win32") return findChromeExecutableWindows();
  return null;
}
