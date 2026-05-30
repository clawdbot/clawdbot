import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Sdk from "@github/copilot-sdk";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export function resolveCopilotSdkFallbackDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "npm-runtime", "copilot");
}

export const COPILOT_SDK_FALLBACK_DIR = resolveCopilotSdkFallbackDir();

export const COPILOT_SDK_SPEC = "@github/copilot-sdk@1.0.0-beta.4";

let cached: Promise<typeof Sdk> | undefined;

export interface LoadCopilotSdkOptions {
  readonly fallbackDir?: string;
  readonly primaryImport?: () => Promise<typeof Sdk>;
  readonly fallbackImport?: (absolutePath: string) => Promise<typeof Sdk>;
  readonly cache?: boolean;
}

export async function loadCopilotSdk(options: LoadCopilotSdkOptions = {}): Promise<typeof Sdk> {
  const useCache = options.cache !== false;
  if (useCache && cached) {
    return cached;
  }

  const promise = doLoad(options);
  if (useCache) {
    cached = promise.catch((err) => {
      cached = undefined;
      throw err;
    });
    return cached;
  }
  return promise;
}

export function resetCopilotSdkCacheForTests(): void {
  cached = undefined;
}

async function doLoad(options: LoadCopilotSdkOptions): Promise<typeof Sdk> {
  const fallbackDir = options.fallbackDir ?? resolveCopilotSdkFallbackDir();
  const primaryImport = options.primaryImport ?? (async () => await import("@github/copilot-sdk"));

  let primaryErr: unknown;
  try {
    return await primaryImport();
  } catch (err) {
    primaryErr = err;
  }

  const fallbackPath = path.join(fallbackDir, "node_modules", "@github", "copilot-sdk");
  if (!existsSync(fallbackPath)) {
    throw createMissingSdkError(primaryErr, undefined, fallbackPath);
  }

  const fallbackImport =
    options.fallbackImport ??
    (async () => {
      // Node ESM rejects directory imports (ERR_UNSUPPORTED_DIR_IMPORT), so
      // resolve the package's real entry through Node's module resolver
      // anchored at fallbackDir before importing.
      const requireFromFallback = createRequire(path.join(fallbackDir, "package.json"));
      const entry = requireFromFallback.resolve("@github/copilot-sdk");
      return (await import(pathToFileURL(entry).href)) as typeof Sdk;
    });

  try {
    return await fallbackImport(fallbackPath);
  } catch (fallbackErr) {
    throw createMissingSdkError(primaryErr, fallbackErr, fallbackPath);
  }
}

function createMissingSdkError(
  primaryErr: unknown,
  fallbackErr: unknown,
  fallbackPath: string,
): Error {
  const lines = [
    "[copilot] @github/copilot-sdk is not installed.",
    "",
    "The external @openclaw/copilot plugin depends on @github/copilot-sdk",
    "(~260 MB after pulling its platform-specific @github/copilot CLI binary).",
    "Reinstall the plugin once with:",
    "",
    "  openclaw plugins install @openclaw/copilot",
    "",
    "For source checkouts or offline repair, install the SDK directly:",
    "",
    `  npm install ${COPILOT_SDK_SPEC}`,
    "",
    `The legacy fallback location is still probed at\n  ${fallbackPath}`,
    "",
    "Primary resolution error:",
    `  ${summarizeError(primaryErr)}`,
  ];
  if (fallbackErr !== undefined) {
    lines.push("", "Fallback resolution error:", `  ${summarizeError(fallbackErr)}`);
  }
  const err = new Error(lines.join("\n"));
  (err as Error & { code?: string }).code = "COPILOT_SDK_MISSING";
  return err;
}

function summarizeError(value: unknown): string {
  if (value === undefined || value === null) {
    return "(none)";
  }
  if (value instanceof Error) {
    return value.message || String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
