// Shared plugin CLI helpers for install logging, file specs, and hooks.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { HOOK_INSTALL_ERROR_CODE } from "../hooks/install.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
export { quietPluginJsonLogger } from "./plugins-json-logger.js";

type HookInternalEntryLike = Record<string, unknown> & { enabled?: boolean };

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

export function createPluginInstallLogger(runtime: RuntimeEnv = defaultRuntime): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => runtime.log(msg),
    warn: (msg) => runtime.log(msg.includes("╭─") ? msg : theme.warn(msg)),
  };
}

export function createHookPackInstallLogger(runtime: RuntimeEnv = defaultRuntime): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
} {
  return {
    info: (msg) => runtime.log(msg),
    warn: (msg) => runtime.log(theme.warn(msg)),
  };
}

export function enableInternalHookEntries(
  config: OpenClawConfig,
  hookNames: string[],
): OpenClawConfig {
  const entries = { ...config.hooks?.internal?.entries } as Record<string, HookInternalEntryLike>;

  for (const hookName of hookNames) {
    entries[hookName] = {
      ...entries[hookName],
      enabled: true,
    };
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      internal: {
        ...config.hooks?.internal,
        enabled: true,
        entries,
      },
    },
  };
}

export function formatPluginInstallWithHookFallbackError(
  pluginError: string,
  hookFallback: { error: string; code?: string },
): string {
  const formattedPluginError = formatPluginInstallAttemptError(pluginError);
  const formattedHookError = formatPluginInstallAttemptError(hookFallback.error);
  if (/plugin already exists: .+ \(delete it first\)/.test(pluginError)) {
    return `${formattedPluginError}\nUse \`openclaw plugins update <id-or-npm-spec>\` to upgrade the tracked plugin, or rerun install with \`--force\` to replace it.`;
  }
  if (
    pluginError.startsWith("Invalid extensions directory:") ||
    pluginError === "Invalid path: must stay within extensions directory"
  ) {
    return formattedPluginError;
  }
  if (hookFallback.code === HOOK_INSTALL_ERROR_CODE.MISSING_OPENCLAW_HOOKS) {
    return formattedPluginError;
  }
  return `${formattedPluginError}\nAlso not a valid hook pack: ${formattedHookError}`;
}

const MISSING_GIT_FOR_NPM_DEPENDENCY_HINT =
  "Git is required because one of this plugin's npm dependencies is fetched from a git URL, but `git` was not found on PATH. Install Git and rerun the install. On Windows, use `winget install --id Git.Git -e` or add a portable Git `bin` directory to PATH.";

function formatPluginInstallAttemptError(error: string): string {
  if (!isMissingGitForNpmDependencyError(error)) {
    return error;
  }
  if (error.includes(MISSING_GIT_FOR_NPM_DEPENDENCY_HINT)) {
    return error;
  }
  return `${error}\n\n${MISSING_GIT_FOR_NPM_DEPENDENCY_HINT}`;
}

function isMissingGitForNpmDependencyError(error: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(error);
  return /\bspawn\s+git\b/u.test(normalized) && /\benoent\b/u.test(normalized);
}

export function logHookPackRestartHint(runtime: RuntimeEnv = defaultRuntime) {
  runtime.log("Restart the gateway to load hooks.");
}

export function logSlotWarnings(warnings: string[], runtime: RuntimeEnv = defaultRuntime) {
  if (warnings.length === 0) {
    return;
  }
  for (const warning of warnings) {
    runtime.log(theme.warn(warning));
  }
}

export function parseNpmPrefixSpec(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm:")) {
    return null;
  }
  return trimmed.slice("npm:".length).trim();
}

export function parseNpmPackPrefixPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm-pack:")) {
    return null;
  }
  return trimmed.slice("npm-pack:".length).trim();
}
