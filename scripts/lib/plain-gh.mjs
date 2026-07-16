import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLAIN_GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const PLAIN_GH_SYSTEM_CANDIDATES = [
  // Prefer package-manager opt paths: bin/gh may intentionally be an Octopool shim.
  "/opt/homebrew/opt/gh/bin/gh",
  "/usr/local/opt/gh/bin/gh",
  "/home/linuxbrew/.linuxbrew/opt/gh/bin/gh",
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
];

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env) {
  return String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
}

export function plainGhEnv(env = process.env) {
  const next = { ...env };
  delete next.CLICOLOR;
  delete next.CLICOLOR_FORCE;
  delete next.COLORTERM;
  delete next.GH_FORCE_TTY;
  next.NO_COLOR = "1";
  next.FORCE_COLOR = "0";
  next.CLICOLOR = "0";
  next.CLICOLOR_FORCE = "0";
  return next;
}

export function resolvePlainGhBin(
  env = process.env,
  systemCandidates = PLAIN_GH_SYSTEM_CANDIDATES,
) {
  if (env.OPENCLAW_GH_BIN) {
    if (isExecutable(env.OPENCLAW_GH_BIN)) {
      return env.OPENCLAW_GH_BIN;
    }
    throw new Error(`OPENCLAW_GH_BIN is not executable: ${env.OPENCLAW_GH_BIN}`);
  }

  for (const candidate of systemCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const homeBin = env.HOME ? path.join(env.HOME, "bin") : "";
  for (const entry of pathEntries(env)) {
    if (homeBin && entry === homeBin) {
      continue;
    }
    const candidate = path.join(entry, process.platform === "win32" ? "gh.exe" : "gh");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  for (const entry of pathEntries(env)) {
    const candidate = path.join(entry, process.platform === "win32" ? "gh.exe" : "gh");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error("missing required command: gh");
}

export function execPlainGh(args, options = {}) {
  const env = plainGhEnv(options.env ?? process.env);
  const ghBin = resolvePlainGhBin(env);
  return execFileSync(ghBin, args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

export function execGhApiRead(endpoint, options = {}) {
  const env = plainGhEnv(options.env ?? process.env);
  // Keep reads on the normal PATH shim; OPENCLAW_GH_BIN pins maintainer writes.
  delete env.OPENCLAW_GH_BIN;
  return execFileSync("gh", ["api", endpoint, "--method", "GET"], {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

export function spawnPlainGh(args, options = {}) {
  const env = plainGhEnv(options.env ?? process.env);
  const ghBin = resolvePlainGhBin(env);
  return spawnSync(ghBin, args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}
