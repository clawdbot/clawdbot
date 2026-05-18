import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { pathExists } from "../utils.js";

export const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";

export function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

function resolveShellBasename(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const platformBasename =
    platform === "win32" ? path.win32.basename(shellPath) : path.basename(shellPath);
  const winBasename = path.win32.basename(shellPath);
  const basename = winBasename.length < platformBasename.length ? winBasename : platformBasename;
  return normalizeLowercaseStringOrEmpty(basename.replace(/\.(?:exe|cmd|bat)$/i, ""));
}

export function resolveShellFromEnv(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellPath = normalizeOptionalString(env.SHELL) ?? "";
  const shellName = shellPath ? resolveShellBasename(shellPath) : "";
  if (shellName === "zsh") {
    return "zsh";
  }
  if (shellName === "bash") {
    return "bash";
  }
  if (shellName === "fish") {
    return "fish";
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return "powershell";
  }
  return "zsh";
}

function sanitizeCompletionBasename(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "openclaw";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resolveCompletionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "completions");
}

export function resolveCompletionCachePath(shell: CompletionShell, binName: string): string {
  const basename = sanitizeCompletionBasename(binName);
  const extension =
    shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
  return path.join(resolveCompletionCacheDir(), `${basename}.${extension}`);
}

/** Check if the completion cache file exists for the given shell. */
export async function completionCacheExists(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const cachePath = resolveCompletionCachePath(shell, binName);
  return pathExists(cachePath);
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

export function formatCompletionSourceLine(
  shell: CompletionShell,
  _binName: string,
  cachePath: string,
): string {
  if (shell === "powershell") {
    return `. '${escapePowerShellSingleQuotedString(cachePath)}'`;
  }
  if (shell === "fish") {
    return `test -f "${cachePath}"; and source "${cachePath}"`;
  }
  return `[ -f "${cachePath}" ] && source "${cachePath}"`;
}

export function formatCompletionReloadCommand(shell: CompletionShell, profilePath: string): string {
  if (shell === "powershell") {
    return `. '${escapePowerShellSingleQuotedString(profilePath)}'`;
  }
  return `source ${profilePath}`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# OpenClaw Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string | null): boolean {
  if (line.includes(`${binName} completion`)) {
    return true;
  }
  if (cachePath && line.includes(cachePath)) {
    return true;
  }
  return false;
}

/** Check if a line uses the slow dynamic completion pattern (source <(...)) */
function isSlowDynamicCompletionLine(line: string, binName: string): boolean {
  return (
    line.includes(`<(${binName} completion`) ||
    (line.includes(`${binName} completion`) && line.includes("| source"))
  );
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string | null,
  sourceLine: string,
): { next: string; changed: boolean; hadExisting: boolean } {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      i += 1;
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# OpenClaw Completion\n${sourceLine}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

export function resolveCompletionProfilePath(
  shell: CompletionShell,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: () => string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir;
  const platform = options.platform ?? process.platform;
  const home = env.HOME || homeDir();
  if (shell === "zsh") {
    return path.join(home, ".zshrc");
  }
  if (shell === "bash") {
    return path.join(home, ".bashrc");
  }
  if (shell === "fish") {
    return path.join(home, ".config", "fish", "config.fish");
  }
  if (platform === "win32") {
    const shellPath = normalizeOptionalString(env.SHELL) ?? "";
    const shellName = shellPath ? resolveShellBasename(shellPath, platform) : "";
    const profileDirectory = shellName === "powershell" ? "WindowsPowerShell" : "PowerShell";
    return path.win32.join(
      env.USERPROFILE || home,
      "Documents",
      profileDirectory,
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const cachePathCandidate = resolveCompletionCachePath(shell, binName);
  const cachedPath = (await pathExists(cachePathCandidate)) ? cachePathCandidate : null;
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");
  return lines.some(
    (line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, cachedPath),
  );
}

/**
 * Check if the profile uses the slow dynamic completion pattern.
 * Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
 */
export async function usesSlowDynamicCompletion(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) {
      return true;
    }
  }
  return false;
}

export async function installCompletion(shell: string, yes: boolean, binName = "openclaw") {
  const isShellSupported = isCompletionShell(shell);
  if (!isShellSupported) {
    console.error(`Automated installation not supported for ${shell} yet.`);
    return;
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const cacheExists = await pathExists(cachePath);
  if (!cacheExists) {
    console.error(
      `Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`,
    );
    return;
  }

  let profilePath: string;
  let sourceLine: string;
  switch (shell) {
    case "zsh":
      profilePath = resolveCompletionProfilePath("zsh");
      sourceLine = formatCompletionSourceLine("zsh", binName, cachePath);
      break;
    case "bash":
      profilePath = resolveCompletionProfilePath("bash");
      try {
        await fs.access(profilePath);
      } catch {
        const home = process.env.HOME || os.homedir();
        profilePath = path.join(home, ".bash_profile");
      }
      sourceLine = formatCompletionSourceLine("bash", binName, cachePath);
      break;
    case "fish":
      profilePath = resolveCompletionProfilePath("fish");
      sourceLine = formatCompletionSourceLine("fish", binName, cachePath);
      break;
    case "powershell":
      profilePath = resolveCompletionProfilePath("powershell");
      sourceLine = formatCompletionSourceLine("powershell", binName, cachePath);
      break;
  }

  try {
    try {
      await fs.access(profilePath);
    } catch {
      if (!yes) {
        console.warn(`Profile not found at ${profilePath}. Created a new one.`);
      }
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, "", "utf-8");
    }

    const content = await fs.readFile(profilePath, "utf-8");
    const update = updateCompletionProfile(content, binName, cachePath, sourceLine);
    if (!update.changed) {
      if (!yes) {
        console.log(`Completion already installed in ${profilePath}`);
      }
      return;
    }

    if (!yes) {
      const action = update.hadExisting ? "Updating" : "Installing";
      console.log(`${action} completion in ${profilePath}...`);
    }

    await fs.writeFile(profilePath, update.next, "utf-8");
    if (!yes) {
      console.log(
        `Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, profilePath)}`,
      );
    }
  } catch (err) {
    console.error(`Failed to install completion: ${err as string}`);
  }
}
