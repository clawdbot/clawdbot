import fs from "node:fs";
import JSON5 from "json5";
import { getCommandPathWithRootOptions } from "../cli/argv.js";
import { resolveConfigPath } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type LoggingConfig = OpenClawConfig["logging"];

let cachedLoggingConfig:
  | {
      path: string;
      logging: LoggingConfig | undefined;
    }
  | undefined;

export function shouldSkipMutatingLoggingConfigRead(argv: string[] = process.argv): boolean {
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  return primary === "config" && (secondary === "schema" || secondary === "validate");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLoggingConfig(): LoggingConfig | undefined {
  if (shouldSkipMutatingLoggingConfigRead()) {
    return undefined;
  }
  try {
    const configPath = resolveConfigPath();
    if (cachedLoggingConfig?.path === configPath) {
      return cachedLoggingConfig.logging;
    }
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    const parsed = JSON5.parse(fs.readFileSync(configPath, "utf8"));
    const logging = isObjectRecord(parsed) ? parsed.logging : undefined;
    const resolved = isObjectRecord(logging) ? (logging as LoggingConfig) : undefined;
    cachedLoggingConfig = {
      path: configPath,
      logging: resolved,
    };
    return resolved;
  } catch {
    return undefined;
  }
}
