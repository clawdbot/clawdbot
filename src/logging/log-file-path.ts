// Log file path helpers resolve log output paths for local runtime logs.
import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import {
  DEFAULT_POSIX_TMP_ROOT,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
import { canUseNodeFs, formatLocalDate, LOG_PREFIX, LOG_SUFFIX } from "./log-file-shared.js";

const ROLLING_LOG_FILE_RE = /^(openclaw(?:-[a-z0-9-]+)?)-(\d{4}-\d{2}-\d{2})\.log$/u;
const MAX_LOG_PROFILE_SEGMENT_LENGTH = 220;

function encodeLogProfileSegment(profile: string): string {
  let encoded = "";
  for (const char of profile) {
    if (/^[a-z0-9]$/u.test(char)) {
      encoded += char;
    } else if (char === "-") {
      encoded += "--";
    } else if (char === "_") {
      encoded += "-0";
    } else if (/^[A-Z]$/u.test(char)) {
      encoded += `-1${char.toLowerCase()}`;
    } else {
      encoded += `-2${char.codePointAt(0)?.toString(16) ?? "0"}-`;
    }
  }
  return encoded;
}

function resolveLogProfileSegment(env: NodeJS.ProcessEnv): string | null {
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return null;
  }
  const encoded = encodeLogProfileSegment(profile);
  if (encoded.length <= MAX_LOG_PROFILE_SEGMENT_LENGTH) {
    return encoded;
  }
  return `-3${createHash("sha256").update(profile).digest("hex")}`;
}

/** Resolves today's default rolling log path for the active CLI profile. */
export function resolveDefaultRollingLogFile(options?: {
  date?: Date;
  env?: NodeJS.ProcessEnv;
  logDir?: string;
}): string {
  const date = options?.date ?? new Date();
  const env = options?.env ?? process.env;
  const logDir =
    options?.logDir ?? (canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : DEFAULT_POSIX_TMP_ROOT);
  const profileSegment = resolveLogProfileSegment(env);
  const profileSuffix = profileSegment ? `-${profileSegment}` : "";
  return path.join(logDir, `${LOG_PREFIX}${profileSuffix}-${formatLocalDate(date)}${LOG_SUFFIX}`);
}

/** Resolves the configured log file or today's rolling default log path. */
export function resolveConfiguredLogFilePath(
  config?: OpenClawConfig | null,
  options?: { date?: Date; env?: NodeJS.ProcessEnv; logDir?: string },
): string {
  return config?.logging?.file ?? resolveDefaultRollingLogFile(options);
}

/** Returns whether a path is one of OpenClaw's dated rolling log files. */
export function isRollingLogFilePath(file: string): boolean {
  return ROLLING_LOG_FILE_RE.test(path.basename(file));
}

/** Returns whether a configured path had the legacy default rolling filename shape. */
export function isLegacyRollingLogFilePath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

/** Advances a rolling log path to the requested date while preserving its profile family. */
export function resolveRollingLogFilePathForDate(file: string, date: Date): string {
  const match = ROLLING_LOG_FILE_RE.exec(path.basename(file));
  if (!match) {
    return isLegacyRollingLogFilePath(file)
      ? path.join(path.dirname(file), `${LOG_PREFIX}-${formatLocalDate(date)}${LOG_SUFFIX}`)
      : file;
  }
  return path.join(path.dirname(file), `${match[1]}-${formatLocalDate(date)}${LOG_SUFFIX}`);
}

/** Returns whether two dated rolling paths belong to the same profile family. */
export function isSameRollingLogFileFamily(left: string, right: string): boolean {
  const leftMatch = ROLLING_LOG_FILE_RE.exec(path.basename(left));
  const rightMatch = ROLLING_LOG_FILE_RE.exec(path.basename(right));
  return Boolean(leftMatch && rightMatch && leftMatch[1] === rightMatch[1]);
}
