import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MigrationLogger, MigrationMessages } from "./state-migrations.types.js";

type NoticeSource = { notices?: readonly string[] } | undefined;

const STARTUP_MIGRATION_FOLLOW_UP =
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';

export function formatStartupMigrationFailure(errors: readonly string[]): string {
  return [
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    ...errors.map((error) => `- ${error}`),
    STARTUP_MIGRATION_FOLLOW_UP,
  ].join("\n");
}

let startupMigrationWarning: string | undefined;

/** The running Gateway owns this boot fact; status and Doctor must not rerun migrations to infer it. */
export function recordStartupMigrationWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) {
    return;
  }
  const details = sanitizeTerminalText(
    redactSensitiveText([...new Set(warnings)].map((warning) => `- ${warning}`).join("\n"), {
      mode: "tools",
    }),
  );
  // Keep this boot fact until restart: a repeated preflight can skip already-checked migrations.
  // Bound model-visible diagnostics; the startup log retains the full redacted report.
  const summary = `${truncateWithMarker(details, 2000, { marker: "… (see startup log)", reserve: 20, trimEnd: true })}\n${STARTUP_MIGRATION_FOLLOW_UP}`;
  if (startupMigrationWarning !== summary) {
    startupMigrationWarning = summary;
    createSubsystemLogger("state-migrations").warn(
      `Startup migration warnings; continuing with degraded state.\n${details}\n${STARTUP_MIGRATION_FOLLOW_UP}`,
    );
  }
}

export function readStartupMigrationWarning(includeSensitive = true): string | undefined {
  // Migration errors can contain host paths; read-only status keeps only the repair hint.
  return (
    startupMigrationWarning &&
    (includeSensitive
      ? startupMigrationWarning
      : `Startup migrations need attention. ${STARTUP_MIGRATION_FOLLOW_UP}`)
  );
}

export function mergeNotices(sources: NoticeSource[]): string[] {
  return [...new Set(sources.flatMap((source) => (source?.notices ? [...source.notices] : [])))];
}

export function logStateMigrationResult(
  result: MigrationMessages,
  logger: MigrationLogger = createSubsystemLogger("state-migrations"),
): void {
  for (const [key, title, level] of [
    ["changes", "Auto-migrated legacy state", "info"],
    ["warnings", "Legacy state migration warnings", "warn"],
    ["notices", "Legacy state migration notes", "info"],
  ] as const) {
    if (result[key]?.length) {
      logger[level](`${title}:\n${result[key].map((entry) => `- ${entry}`).join("\n")}`);
    }
  }
}
