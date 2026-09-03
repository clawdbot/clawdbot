// Shell completion runtime: cache paths, profile installation, and shell detection.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { isErrno } from "../infra/errors.js";
import { decodeWindowsTextFileBuffer } from "../infra/windows-encoding.js";
import { pathExists } from "../utils.js";
import { publishOutputFileAtomically } from "./output-file.runtime.js";

export const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";

type CompletionProfileEncoding = "utf8" | "utf8bom" | "utf16le" | "utf16be";

async function readCompletionProfile(profilePath: string, shell: CompletionShell) {
  const buffer = await fs.readFile(profilePath);
  let encoding: CompletionProfileEncoding = "utf8";
  if (shell === "powershell" && process.platform === "win32") {
    const [first, second, third] = buffer;
    if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) {
      encoding = first === 0xff ? "utf16le" : "utf16be";
    } else if (first === 0xef && second === 0xbb && third === 0xbf) {
      encoding = "utf8bom";
    }
  }
  // Removing an owned first line must not remove the profile's encoding declaration.
  return {
    content:
      encoding === "utf8" ? buffer.toString("utf8") : decodeWindowsTextFileBuffer({ buffer }),
    encoding,
  };
}

function encodeCompletionProfile(content: string, encoding: CompletionProfileEncoding): Buffer {
  if (encoding === "utf8") {
    return Buffer.from(content, "utf8");
  }
  const buffer = Buffer.from(`\uFEFF${content}`, encoding === "utf8bom" ? "utf8" : "utf16le");
  return encoding === "utf16be" ? buffer.swap16() : buffer;
}

/** Narrows an arbitrary shell label to a completion shell supported by installer logic. */
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

/** Resolves the active shell from environment paths, using the platform's native default. */
export function resolveShellFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CompletionShell {
  const shellPath = normalizeOptionalString(env.SHELL) ?? "";
  const shellName = shellPath ? resolveShellBasename(shellPath, platform) : "";
  if (isCompletionShell(shellName)) {
    return shellName;
  }
  if (shellName === "pwsh") {
    return "powershell";
  }
  return platform === "win32" ? "powershell" : "zsh";
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

/** Returns the per-shell cached completion script path for a sanitized CLI binary name. */
export function resolveCompletionCachePath(shell: CompletionShell, binName: string): string {
  const basename = sanitizeCompletionBasename(binName);
  return path.join(
    resolveCompletionCacheDir(),
    `${basename}.${shell === "powershell" ? "ps1" : shell}`,
  );
}

/** Check if the completion cache file exists for the given shell. */
export async function completionCacheExists(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const cachePath = resolveCompletionCachePath(shell, binName);
  return pathExists(cachePath);
}

function quoteCompletionPath(shell: CompletionShell, value: string): string {
  if (shell === "powershell") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  // Single quotes also keep pasted reload hints literal when interactive history expansion is on.
  const escaped =
    shell === "fish" ? value.replace(/[\\']/gu, "\\$&") : value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

function formatCompletionSourceLine(shell: CompletionShell, cachePath: string): string {
  const quotedPath = quoteCompletionPath(shell, cachePath);
  if (shell === "powershell") {
    return `. ${quotedPath}`;
  }
  if (shell === "fish") {
    return `test -f ${quotedPath}; and source ${quotedPath}`;
  }
  return `[ -f ${quotedPath} ] && source ${quotedPath}`;
}

function appendCompletionProfilePath(
  directory: string,
  pathApi: typeof path.posix,
  ...segments: string[]
): string {
  // Shell startup resolves symlinks before `..`; path.join would select a different profile.
  const nativeDirectory = pathApi.sep === "\\" ? directory.replaceAll("/", pathApi.sep) : directory;
  const separator = nativeDirectory.endsWith(pathApi.sep) ? "" : pathApi.sep;
  return `${nativeDirectory}${separator}${segments.join(pathApi.sep)}`;
}

/** Formats the command users can run to reload the shell profile after installation. */
export function formatCompletionReloadCommand(shell: CompletionShell, profilePath: string): string {
  if (shell === "powershell") {
    return `. ${quoteCompletionPath(shell, profilePath)}`;
  }
  if (/^[a-zA-Z0-9_./~+-]+$/u.test(profilePath)) {
    return `source ${profilePath}`;
  }
  const homePrefix = profilePath.startsWith("~/") ? "~/" : "";
  const value = profilePath.slice(homePrefix.length);
  return `source ${homePrefix}${quoteCompletionPath(shell, value)}`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# OpenClaw Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string): boolean {
  if (isSlowDynamicCompletionLine(line, binName)) {
    return true;
  }
  const trimmed = line.trim();
  return (
    // Stable releases wrote these paths without escaping shell expansion characters.
    trimmed === `source "${cachePath}"` ||
    trimmed === `[ -f "${cachePath}" ] && source "${cachePath}"` ||
    trimmed === `test -f "${cachePath}"; and source "${cachePath}"` ||
    COMPLETION_SHELLS.some((shell) => trimmed === formatCompletionSourceLine(shell, cachePath))
  );
}

function isPreviousCompletionSourceLine(
  line: string,
  currentCachePath: string,
  shell: CompletionShell,
): boolean {
  const trimmed = line.trim();
  const guarded = /^(?:\[\s+-f|test\s+-f)\s+(.+?)\s*(?:\]\s*&&|;\s*and)\s+source\s+\1$/u.exec(
    trimmed,
  );
  const direct = /^(source|\.)\s+(.+)$/u.exec(trimmed);
  const quotedPath = guarded?.[1] ?? direct?.[2];
  if (!quotedPath) {
    return false;
  }
  const quoteShell = direct?.[1] === "." ? "powershell" : shell;
  // Old guarded emitters repeated raw paths even when they contained quotes.
  const legacyPath = guarded
    ? /^"(.+)"$/u.exec(quotedPath)?.[1]
    : /^source\s+"([^"]+)"$/u.exec(trimmed)?.[1];
  const escapedPath = quotedPath.slice(1, -1);
  const sourcePath =
    legacyPath ??
    (quoteShell === "powershell"
      ? escapedPath.replaceAll("''", "'")
      : quoteShell === "fish"
        ? escapedPath.replace(/\\([\\'])/gu, "$1")
        : escapedPath.replaceAll("'\\''", "'"));
  // Only our complete literal operand is owned; never consume compound profile commands.
  if (!legacyPath && quoteCompletionPath(quoteShell, sourcePath) !== quotedPath) {
    return false;
  }
  const sourcePaths = sourcePath.includes("\\") ? path.win32 : path;
  return (
    sourcePaths.basename(sourcePaths.dirname(sourcePath)) === "completions" &&
    sourcePaths.basename(sourcePath) === path.basename(currentCachePath)
  );
}

function isOwnedCompletionInvocation(invocation: string, binName: string): boolean {
  const [command, action, ...args] = invocation.trim().split(/\s+/u);
  if (command !== binName || action !== "completion") {
    return false;
  }
  if (args.length === 2 && (args[0] === "--shell" || args[0] === "-s")) {
    return isCompletionShell(args[1] ?? "");
  }
  return (
    args.length === 0 ||
    (args.length === 1 && isCompletionShell((args[0] ?? "").replace(/^(?:--shell=|-s=?)/u, "")))
  );
}

/** Check if a line uses an owned slow dynamic completion pattern (source <(...)). */
function isSlowDynamicCompletionLine(line: string, binName: string): boolean {
  const trimmed = line.trim();
  const dynamicMarker = `<(${binName} completion`;
  const markerIndex = trimmed.indexOf(dynamicMarker);
  if (markerIndex >= 0) {
    const expression = trimmed.slice(markerIndex);
    // Compound profile statements are user-owned; deleting the entire line loses their commands.
    return (
      /^(?:(?:\[\s+-f\s+[^\]]+\]\s*&&\s*)?(?:source|\.))\s*$/u.test(
        trimmed.slice(0, markerIndex).trimEnd(),
      ) &&
      expression.endsWith(")") &&
      isOwnedCompletionInvocation(expression.slice(2, -1), binName)
    );
  }
  const invocationIndex = trimmed.indexOf(`${binName} completion`);
  if (invocationIndex < 0) {
    return false;
  }
  const invocationPrefix = trimmed.slice(0, invocationIndex).trimEnd();
  const evalPrefix = /^eval\s+(["']?)\$\($/u.exec(invocationPrefix);
  if (evalPrefix) {
    const invocation = trimmed.slice(invocationIndex);
    const closing = `)${evalPrefix[1] ?? ""}`;
    return (
      invocation.endsWith(closing) &&
      isOwnedCompletionInvocation(invocation.slice(0, -closing.length), binName)
    );
  }
  if (invocationIndex !== 0 || /[;&]/u.test(trimmed)) {
    return false;
  }
  const pipeline = trimmed.split("|").map((stage) => stage.trim());
  const terminal = pipeline.at(-1) ?? "";
  // Only the documented optional Out-String stage is owned by completion migration.
  return (
    isOwnedCompletionInvocation(pipeline[0] ?? "", binName) &&
    /^(?:source|Invoke-Expression|iex)$/iu.test(terminal) &&
    (pipeline.length === 2 || (pipeline.length === 3 && /^Out-String$/iu.test(pipeline[1] ?? "")))
  );
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string,
  shell: CompletionShell,
): { next: string; changed: boolean; hadExisting: boolean } {
  // Remove both cached and old dynamic blocks so installs converge to one fast source line.
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      // An orphaned marker owns no following user line; remove only a recognized source line.
      const following = lines[i + 1] ?? "";
      if (
        isCompletionProfileLine(following, binName, cachePath) ||
        isPreviousCompletionSourceLine(following, cachePath, shell)
      ) {
        i += 1;
      }
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# OpenClaw Completion\n${formatCompletionSourceLine(shell, cachePath)}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

async function resolveCompletionProfileWritePath(profilePath: string): Promise<string> {
  const profileDir = path.dirname(profilePath);
  // Shell startup follows a symlink before `..`; create and canonicalize that lexical parent first.
  await fs.mkdir(profileDir, { recursive: true });
  const canonicalDir = await fs.realpath(profileDir);
  try {
    // Existing dotfile-manager symlinks must keep pointing at the atomically replaced referent.
    return await fs.realpath(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const linkTarget = await fs.readlink(profilePath).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EINVAL") {
      return undefined;
    }
    throw error;
  });
  if (linkTarget === undefined) {
    return path.join(canonicalDir, path.basename(profilePath));
  }
  // A dangling relative link is resolved from the directory that physically owns the link.
  const targetPath = path.isAbsolute(linkTarget)
    ? linkTarget
    : `${canonicalDir}${path.sep}${linkTarget}`;
  const targetDir = path.dirname(targetPath);
  await fs.mkdir(targetDir, { recursive: true });
  return path.join(await fs.realpath(targetDir), path.basename(targetPath));
}

/** Resolves the shell startup profile path that should contain the OpenClaw completion block. */
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
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = env.HOME || homeDir();
  if (shell === "zsh") {
    const profileDirectory = env.ZDOTDIR === undefined ? home : env.ZDOTDIR || pathApi.sep;
    return appendCompletionProfilePath(profileDirectory, pathApi, ".zshrc");
  }
  if (shell === "bash") {
    // Installation, status, and repairs must inspect the same real Bash profile.
    const bashrc = appendCompletionProfilePath(home, pathApi, ".bashrc");
    return existsSync(bashrc)
      ? bashrc
      : appendCompletionProfilePath(home, pathApi, ".bash_profile");
  }
  if (shell === "fish") {
    const configuredHome = env.XDG_CONFIG_HOME;
    const configHome =
      configuredHome && pathApi.isAbsolute(configuredHome)
        ? configuredHome
        : appendCompletionProfilePath(home, pathApi, ".config");
    return appendCompletionProfilePath(configHome, pathApi, "fish", "config.fish");
  }
  if (platform === "win32") {
    const shellPath = normalizeOptionalString(env.SHELL) ?? "";
    const shellName = shellPath ? resolveShellBasename(shellPath, platform) : "";
    const profileDirectory = shellName === "powershell" ? "WindowsPowerShell" : "PowerShell";
    return appendCompletionProfilePath(
      env.USERPROFILE || home,
      pathApi,
      "Documents",
      profileDirectory,
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return appendCompletionProfilePath(
    home,
    pathApi,
    ".config",
    "powershell",
    "Microsoft.PowerShell_profile.ps1",
  );
}

/** Formats the resolved startup profile relative to HOME when that preserves its actual location. */
export function resolveCompletionProfileHint(shell: CompletionShell): string {
  const profilePath = resolveCompletionProfilePath(shell);
  if (shell === "powershell") {
    return profilePath;
  }
  if (!path.isAbsolute(profilePath)) {
    return profilePath.startsWith(`.${path.sep}`) || profilePath.startsWith(`..${path.sep}`)
      ? profilePath
      : `.${path.sep}${profilePath}`;
  }
  const home = process.env.HOME;
  // Keep lexical parent components so reload follows the same symlink path as installation.
  return home && profilePath.startsWith(`${home}${path.sep}`)
    ? `~/${profilePath.slice(home.length + 1)}`
    : profilePath;
}

/** Returns whether a shell profile already contains an OpenClaw completion block or source line. */
export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const cachePath = resolveCompletionCachePath(shell, binName);
  const { content } = await readCompletionProfile(profilePath, shell);
  const lines = content.split("\n");
  // A marker does not install completion; retain missing-cache source lines for doctor repair.
  return lines.some((line) => isCompletionProfileLine(line, binName, cachePath));
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
  const { content } = await readCompletionProfile(profilePath, shell);
  return content
    .split("\n")
    .some((line) => isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath));
}

const PROFILE_WRITE_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export function findCompletionProfileWriteError(err: unknown): NodeJS.ErrnoException | undefined {
  if (isErrno(err) && PROFILE_WRITE_ERROR_CODES.has(err.code ?? "")) {
    return err;
  }
  return err instanceof Error ? findCompletionProfileWriteError(err.cause) : undefined;
}

export async function installCompletion(shell: string, yes: boolean, binName = "openclaw") {
  if (!isCompletionShell(shell)) {
    throw new Error(`Automated installation not supported for ${shell} yet.`);
  }

  const cachePath = resolveCompletionCachePath(shell, binName);
  const cacheExists = await pathExists(cachePath);
  if (!cacheExists) {
    throw new Error(
      `Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`,
    );
  }

  const profilePath = resolveCompletionProfilePath(shell);

  try {
    let content: string;
    let encoding: CompletionProfileEncoding = "utf8";
    try {
      ({ content, encoding } = await readCompletionProfile(profilePath, shell));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (!yes) {
        console.warn(`Profile not found at ${profilePath}. Creating a new one.`);
      }
      content = "";
    }

    const update = updateCompletionProfile(content, binName, cachePath, shell);
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

    await publishOutputFileAtomically({
      filePath: await resolveCompletionProfileWritePath(profilePath),
      tempPrefix: ".openclaw-completion-profile",
      durable: true,
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, encodeCompletionProfile(update.next, encoding), {
          flag: "wx",
        });
      },
    });
    if (!yes) {
      console.log(
        `Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, resolveCompletionProfileHint(shell))}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to install completion: ${message}`, { cause: err });
  }
}
