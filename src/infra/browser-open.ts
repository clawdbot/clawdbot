import { runCommandWithTimeout } from "../process/exec.js";
import { detectBinary } from "./detect-binary.js";
import { isWSL } from "./wsl.js";

export type BrowserOpenCommand = {
  argv: string[] | null;
  reason?: string;
  command?: string;
};

export type BrowserOpenSupport = {
  ok: boolean;
  reason?: string;
  command?: string;
};

function shouldSkipBrowserOpenInTests(): boolean {
  if (process.env.VITEST) {
    return true;
  }
  return process.env.NODE_ENV === "test";
}

export async function resolveBrowserOpenCommand(): Promise<BrowserOpenCommand> {
  const platform = process.platform;
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const isSsh =
    Boolean(process.env.SSH_CLIENT) ||
    Boolean(process.env.SSH_TTY) ||
    Boolean(process.env.SSH_CONNECTION);

  if (isSsh && !hasDisplay && platform !== "win32") {
    return { argv: null, reason: "ssh-no-display" };
  }

  if (platform === "win32") {
    return {
      argv: ["explorer.exe"],
      command: "explorer.exe",
    };
  }

  if (platform === "darwin") {
    const hasOpen = await detectBinary("open");
    return hasOpen ? { argv: ["open"], command: "open" } : { argv: null, reason: "missing-open" };
  }

  if (platform === "linux") {
    const wsl = await isWSL();
    if (!hasDisplay && !wsl) {
      return { argv: null, reason: "no-display" };
    }
    if (wsl) {
      const hasWslview = await detectBinary("wslview");
      if (hasWslview) {
        return { argv: ["wslview"], command: "wslview" };
      }
      if (!hasDisplay) {
        return { argv: null, reason: "wsl-no-wslview" };
      }
    }
    const hasXdgOpen = await detectBinary("xdg-open");
    return hasXdgOpen
      ? { argv: ["xdg-open"], command: "xdg-open" }
      : { argv: null, reason: "missing-xdg-open" };
  }

  return { argv: null, reason: "unsupported-platform" };
}

export async function detectBrowserOpenSupport(): Promise<BrowserOpenSupport> {
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) {
    return { ok: false, reason: resolved.reason };
  }
  return { ok: true, command: resolved.command };
}

export async function openUrl(url: string): Promise<boolean> {
  if (shouldSkipBrowserOpenInTests()) {
    return false;
  }
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv) {
    return false;
  }
  const command = [...resolved.argv];
  command.push(url);
  try {
    await runCommandWithTimeout(command, { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function openUrlInBackground(url: string): Promise<boolean> {
  if (shouldSkipBrowserOpenInTests()) {
    return false;
  }
  if (process.platform !== "darwin") {
    return false;
  }
  const resolved = await resolveBrowserOpenCommand();
  if (!resolved.argv || resolved.command !== "open") {
    return false;
  }
  try {
    await runCommandWithTimeout(["open", "-g", url], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}
