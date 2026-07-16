// Imessage plugin module classifies CLI and Messages database locality.
import { constants, accessSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const localCliPathCache = new Map<string, boolean>();
const MACH_O_MAGICS = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "cafebabf",
  "bebafeca",
  "bfbafeca",
]);

function safeHomeDir(): string | undefined {
  const home = process.env.HOME?.trim();
  if (home) {
    return home;
  }
  try {
    return os.homedir().trim() || undefined;
  } catch {
    return undefined;
  }
}

function expandIMessageUserPath(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  const home = safeHomeDir();
  return home ? value.replace(/^~(?=$|[\\/])/, home) : value;
}

function resolveIMessageExecutable(cliPath: string): string | undefined {
  const expanded = expandIMessageUserPath(cliPath);
  if (expanded.includes(path.sep)) {
    return expanded;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, expanded);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH until an executable candidate is found.
    }
  }
  return undefined;
}

function isMachOExecutable(filePath: string): boolean {
  try {
    return MACH_O_MAGICS.has(readFileSync(realpathSync(filePath)).subarray(0, 4).toString("hex"));
  } catch {
    return false;
  }
}

function isProvenLocalIMessageCliPath(params: { cliPath: string; remoteHost?: string }): boolean {
  if (params.remoteHost?.trim()) {
    return false;
  }
  const cliPath = params.cliPath.trim();
  const cacheKey = `${cliPath}\0${process.env.PATH ?? ""}`;
  const cached = localCliPathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const executable = resolveIMessageExecutable(cliPath);
  let local = executable ? isMachOExecutable(executable) : false;
  if (executable && !local) {
    try {
      const wrapper = readFileSync(realpathSync(executable), "utf8");
      const match = wrapper.match(
        /^#![^\r\n]+\r?\n\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"\s*$/u,
      );
      const target = match?.[1] ?? match?.[2] ?? match?.[3];
      local = Boolean(target && path.isAbsolute(target) && isMachOExecutable(target));
    } catch {
      local = false;
    }
  }
  // CLI installation is process-stable channel metadata; avoid repeated file reads.
  localCliPathCache.set(cacheKey, local);
  return local;
}

function isLikelyLocalIMessageCliPath(params: { cliPath: string; remoteHost?: string }): boolean {
  if (params.remoteHost?.trim()) {
    return false;
  }
  const cliPath = params.cliPath.trim();
  if (cliPath === "imsg") {
    return true;
  }
  if (path.basename(cliPath) !== "imsg") {
    return false;
  }
  try {
    return !/\bssh\b[\s\S]*\bimsg\b/u.test(readFileSync(expandIMessageUserPath(cliPath), "utf8"));
  } catch {
    return true;
  }
}

function defaultMessagesDbPath(): string | undefined {
  const home = safeHomeDir();
  return home ? path.join(home, "Library", "Messages", "chat.db") : undefined;
}

export function resolveIMessageChatDbLookupPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  const configured = params.dbPath?.trim();
  if (configured) {
    return configured;
  }
  // Receipt recovery is best effort and preserves the shipped wrapper heuristic.
  if (!isLikelyLocalIMessageCliPath({ cliPath: params.cliPath, remoteHost: params.remoteHost })) {
    return undefined;
  }
  return defaultMessagesDbPath();
}

export function resolveLocalIMessageChatDbPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  // Authorization may use chat.db only after positively attesting a local imsg executable.
  if (!isProvenLocalIMessageCliPath({ cliPath: params.cliPath, remoteHost: params.remoteHost })) {
    return undefined;
  }
  const configured = params.dbPath?.trim();
  return configured ? expandIMessageUserPath(configured) : defaultMessagesDbPath();
}
