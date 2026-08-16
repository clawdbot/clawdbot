// Logging config helpers read and normalize logger configuration.
import fs from "node:fs";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { resolveConfigIncludes, resolveConfigIncludesForTopLevelKey } from "../config/includes.js";
import { resolveConfigPath, resolveIncludeRoots } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

// Lightweight logging-config reader used before the full config runtime is safe to load.
type LoggingConfig = NonNullable<OpenClawConfig["logging"]>;

let cachedLoggingConfig:
  | {
      path: string;
      logging: LoggingConfig | undefined;
    }
  | undefined;

function resolvePartialDiagnosticLoggingConfig(logging: unknown): LoggingConfig | undefined {
  if (!isObjectRecord(logging)) {
    return undefined;
  }
  const partial: Record<string, unknown> = {};
  if (typeof logging.consoleStyle === "string") {
    try {
      const resolved = resolveConfigEnvVars({ consoleStyle: logging.consoleStyle });
      if (
        isObjectRecord(resolved) &&
        (resolved.consoleStyle === "pretty" ||
          resolved.consoleStyle === "compact" ||
          resolved.consoleStyle === "json")
      ) {
        partial.consoleStyle = resolved.consoleStyle;
      }
    } catch {
      // Keep resolving independent diagnostic fields.
    }
  }
  if (Array.isArray(logging.redactPatterns)) {
    try {
      const resolved = resolveConfigEnvVars({ redactPatterns: logging.redactPatterns });
      if (
        isObjectRecord(resolved) &&
        Array.isArray(resolved.redactPatterns) &&
        resolved.redactPatterns.every((entry) => typeof entry === "string")
      ) {
        partial.redactPatterns = resolved.redactPatterns;
      }
    } catch {
      // A missing variable in one pattern must not hide a separately resolvable style.
    }
  }
  return Object.keys(partial).length > 0 ? (partial as LoggingConfig) : undefined;
}

/** Reads the logging block from config, caching by resolved config path. */
export function readLoggingConfig(): LoggingConfig | undefined {
  try {
    const configPath = resolveConfigPath();
    if (cachedLoggingConfig?.path === configPath) {
      return cachedLoggingConfig.logging;
    }
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(configPath, "utf8"));
    const allowedRoots = resolveIncludeRoots();
    let includedConfig: unknown;
    try {
      includedConfig = resolveConfigIncludesForTopLevelKey(
        parsed,
        configPath,
        "logging",
        undefined,
        { allowedRoots },
      );
    } catch {
      // Validation commands still need a directly-authored logging style when an unrelated
      // root include is malformed. Resolve only that subtree through the same canonical rules.
      const directLogging = isObjectRecord(parsed) ? parsed.logging : undefined;
      if (directLogging === undefined) {
        return undefined;
      }
      try {
        includedConfig = resolveConfigIncludes({ logging: directLogging }, configPath, undefined, {
          allowedRoots,
        });
      } catch {
        const logging = resolvePartialDiagnosticLoggingConfig(directLogging);
        return logging;
      }
    }
    let resolvedConfig: unknown;
    try {
      resolvedConfig = resolveConfigEnvVars(includedConfig);
    } catch {
      const includedLogging = isObjectRecord(includedConfig) ? includedConfig.logging : undefined;
      const logging = resolvePartialDiagnosticLoggingConfig(includedLogging);
      return logging;
    }
    const logging = isObjectRecord(resolvedConfig) ? resolvedConfig.logging : undefined;
    const resolvedLogging = isObjectRecord(logging) ? (logging as LoggingConfig) : undefined;
    cachedLoggingConfig = {
      path: configPath,
      logging: resolvedLogging,
    };
    return resolvedLogging;
  } catch {
    return undefined;
  }
}
