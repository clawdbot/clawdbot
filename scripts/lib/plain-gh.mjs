import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** @typedef {import("node:child_process").ExecFileSyncOptions} ExecFileSyncOptions */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithBufferEncoding} ExecFileSyncOptionsWithBufferEncoding */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} ExecFileSyncOptionsWithStringEncoding */
/**
 * @typedef {(
 *   command: string,
 *   args: readonly string[],
 *   options: ExecFileSyncOptions,
 * ) => string | Uint8Array<ArrayBuffer>} ExecGhReadImpl
 */

const PLAIN_GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const PLAIN_GH_SYSTEM_CANDIDATES = [
  // Prefer package-manager opt paths: bin/gh may intentionally be an Octopool shim.
  "/opt/homebrew/opt/gh/bin/gh",
  "/usr/local/opt/gh/bin/gh",
  "/home/linuxbrew/.linuxbrew/opt/gh/bin/gh",
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
];

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function pathEntries(env) {
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
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

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {readonly string[]} [systemCandidates]
 * @returns {string}
 */
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

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execPlainGh(args, options = {}) {
  const env = plainGhEnv(options.env ?? process.env);
  const ghBin = resolvePlainGhBin(env);
  return execFileSync(ghBin, args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhRead(args, options = {}, params = {}) {
  const env = plainGhEnv(options.env ?? process.env);
  // Reads stay on the cache-aware PATH shim; the explicit binary is reserved for writes.
  delete env.OPENCLAW_GH_BIN;
  const execFileSyncImpl = params.execFileSyncImpl ?? execFileSync;
  return execFileSyncImpl("gh", args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {unknown}
 */
export function execGhJson(args, options = {}, params = {}) {
  return JSON.parse(execGhRead(args, { ...options, encoding: "utf8" }, params));
}

/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhApiRead(endpoint, options = {}) {
  return execGhRead(["api", endpoint, "--method", "GET"], options);
}
