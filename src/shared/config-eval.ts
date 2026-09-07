// Config evaluation helpers load dynamic config modules with guarded evaluation.
import fs from "node:fs";
import path from "node:path";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Normalizes primitive config values into the truthiness rules used by requirements checks. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

/** Resolves dotted config paths, tolerating extra dots and missing branches. */
function resolveConfigPath(config: unknown, pathStr: string): unknown {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (isBlockedObjectKey(part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function hasBlockedConfigPathSegment(pathStr: string): boolean {
  return pathStr
    .split(".")
    .filter(Boolean)
    .some((part) => isBlockedObjectKey(part));
}

/** Checks a config path with fallback defaults only when the path is unresolved. */
export function isConfigPathTruthyWithDefaults(
  config: unknown,
  pathStr: string,
  defaults: Record<string, boolean>,
): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (
    value === undefined &&
    !hasBlockedConfigPathSegment(pathStr) &&
    Object.hasOwn(defaults, pathStr)
  ) {
    return defaults[pathStr] ?? false;
  }
  return isTruthy(value);
}

type RuntimeRequires = {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
};

type RuntimeRequirementEvalParams = {
  requires?: RuntimeRequires;
  hasBin: (bin: string) => boolean;
  hasAnyRemoteBin?: (bins: string[]) => boolean;
  hasRemoteBin?: (bin: string) => boolean;
  hasEnv: (envName: string) => boolean;
  isConfigPathTruthy: (pathStr: string) => boolean;
};

/** Evaluates binary/env/config requirements against local and optional remote capabilities. */
function evaluateRuntimeRequires(params: RuntimeRequirementEvalParams): boolean {
  const requires = params.requires;
  if (!requires) {
    return true;
  }

  const requiredBins = requires.bins ?? [];
  if (requiredBins.length > 0) {
    for (const bin of requiredBins) {
      if (params.hasBin(bin)) {
        continue;
      }
      if (params.hasRemoteBin?.(bin)) {
        continue;
      }
      return false;
    }
  }

  const requiredAnyBins = requires.anyBins ?? [];
  if (requiredAnyBins.length > 0) {
    const anyFound = requiredAnyBins.some((bin) => params.hasBin(bin));
    if (!anyFound && !params.hasAnyRemoteBin?.(requiredAnyBins)) {
      return false;
    }
  }

  const requiredEnv = requires.env ?? [];
  if (requiredEnv.length > 0) {
    for (const envName of requiredEnv) {
      if (!params.hasEnv(envName)) {
        return false;
      }
    }
  }

  const requiredConfig = requires.config ?? [];
  if (requiredConfig.length > 0) {
    for (const configPath of requiredConfig) {
      if (!params.isConfigPathTruthy(configPath)) {
        return false;
      }
    }
  }

  return true;
}

/** Enforces OS compatibility before allowing `always` to bypass runtime requirements. */
export function evaluateRuntimeEligibility(
  params: {
    os?: string[];
    remotePlatforms?: string[];
    always?: boolean;
  } & RuntimeRequirementEvalParams,
): boolean {
  const osList = params.os ?? [];
  const remotePlatforms = params.remotePlatforms ?? [];
  if (
    osList.length > 0 &&
    !osList.includes(process.platform) &&
    !remotePlatforms.some((platform) => osList.includes(platform))
  ) {
    return false;
  }
  if (params.always === true) {
    return true;
  }
  return evaluateRuntimeRequires(params);
}

function windowsPathExtensions(): string[] {
  const raw = process.env.PATHEXT;
  const list =
    raw !== undefined ? raw.split(";").map((v) => v.trim()) : [".EXE", ".CMD", ".BAT", ".COM"];
  return ["", ...list.filter(Boolean)];
}

let cachedHasBinaryPath: string | undefined;
let cachedHasBinaryPathExt: string | undefined;
// Installs can create binaries under unchanged PATH/PATHEXT, so cache only successful probes.
const hasBinaryCache = new Set<string>();

/** Checks PATH for an executable binary, including PATHEXT candidates on Windows. */
export function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const pathExt = process.platform === "win32" ? (process.env.PATHEXT ?? "") : "";
  if (cachedHasBinaryPath !== pathEnv || cachedHasBinaryPathExt !== pathExt) {
    cachedHasBinaryPath = pathEnv;
    cachedHasBinaryPathExt = pathExt;
    hasBinaryCache.clear();
  }
  if (hasBinaryCache.has(bin)) {
    return true;
  }

  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? windowsPathExtensions() : [""];
  for (const part of parts) {
    for (const ext of extensions) {
      const candidate = path.join(part, bin + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        hasBinaryCache.add(bin);
        return true;
      } catch {
        // keep scanning
      }
    }
  }
  return false;
}
