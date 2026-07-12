// Doctor contribution for low disk space around the OpenClaw state directory.
import os from "node:os";
import { expectDefined, formatByteSize } from "@openclaw/normalization-core";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { tryReadDiskSpace } from "../infra/disk-space.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { shortenHomePath } from "../utils.js";

const DISK_SPACE_CHECK_ID = "core/doctor/disk-space";

// 100 MB — below this, config writes and session transcripts are likely to
// fail silently, causing data loss.
const CRITICAL_BYTES = 100 * 1024 * 1024;

// 500 MB — enough headroom for normal operation but worth a heads-up so
// operators can free space before it becomes critical.
const WARNING_BYTES = 500 * 1024 * 1024;

/**
 * Format a byte count into a human-readable string (B / KB / MB / GB).
 * Uses Math.floor for MB/KB values to avoid rounding up past a decision
 * threshold (e.g. 99.6 MB should display as "99 MB", not "100 MB").
 * Exported for testing.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) {
    return "unknown";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "giga",
    separator: " ",
    fractionDigits: (_value, unit) => (unit === "byte" ? null : unit === "giga" ? 1 : 0),
    floorUnits: ["kilo", "mega"],
  });
}

/**
 * Build warning lines based on available disk space.
 * Pure function — exported for testing without FS side effects.
 */
export function buildDiskSpaceWarnings(params: {
  availableBytes: number;
  displayStateDir: string;
}): string[] {
  const { availableBytes, displayStateDir } = params;
  const displayFreeSpace = formatBytes(availableBytes);
  const warnings: string[] = [];

  if (availableBytes < CRITICAL_BYTES) {
    warnings.push(
      `- CRITICAL: only ${displayFreeSpace} free on the partition containing ${displayStateDir}.`,
    );
    warnings.push("- Config writes, session transcripts, and log rotation may fail silently.");
    warnings.push("- Free up disk space immediately to avoid data loss.");
  } else if (availableBytes < WARNING_BYTES) {
    warnings.push(
      `- Low disk space: ${displayFreeSpace} free on the partition containing ${displayStateDir}.`,
    );
    warnings.push("- Consider freeing space to prevent future config/session write failures.");
  }

  return warnings;
}

function collectDiskSpaceWarnings(params: {
  env?: NodeJS.ProcessEnv;
  readDiskSpace?: (targetPath: string) => { availableBytes: number } | null;
}): { availableBytes: number; stateDir: string; warnings: readonly string[] } | null {
  const env = params.env ?? process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);

  const readDiskSpace = params.readDiskSpace ?? tryReadDiskSpace;
  const snapshot = readDiskSpace(stateDir);
  // If we cannot determine free space (no existing ancestor, unsupported FS,
  // or permission error), skip silently — other contributions already
  // handle missing directories.
  if (!snapshot) {
    return null;
  }

  const displayStateDir = shortenHomePath(stateDir);
  const warnings = buildDiskSpaceWarnings({
    availableBytes: snapshot.availableBytes,
    displayStateDir,
  });

  return {
    availableBytes: snapshot.availableBytes,
    stateDir,
    warnings,
  };
}

/** Collects read-only structured findings for low disk space around the state directory. */
export function collectDiskSpaceHealthFindings(
  _cfg: OpenClawConfig, // reserved for API consistency with other Doctor contributions
  deps?: {
    env?: NodeJS.ProcessEnv;
    readDiskSpace?: (targetPath: string) => { availableBytes: number } | null;
  },
): readonly HealthFinding[] {
  const result = collectDiskSpaceWarnings({
    env: deps?.env,
    readDiskSpace: deps?.readDiskSpace,
  });
  if (!result || result.warnings.length === 0) {
    return [];
  }

  const [message, ...details] = result.warnings;
  return [
    {
      checkId: DISK_SPACE_CHECK_ID,
      severity: "warning",
      message: expectDefined(message, "disk-space warning message").replace(/^- /, ""),
      path: result.stateDir,
      target: formatBytes(result.availableBytes),
      requirement:
        result.availableBytes < CRITICAL_BYTES ? "critical-free-space" : "low-free-space",
      fixHint: details.map((line) => line.replace(/^- /, "")).join(" "),
    },
  ];
}

/**
 * Doctor health contribution: check free disk space on the partition that
 * holds the state directory and warn when it drops below safe thresholds.
 *
 * This catches a common operational failure mode where OpenClaw silently
 * fails to write config, sessions, or logs because the disk is full.
 *
 * Disk-space probing (statfs + nearest-existing-ancestor resolution) is
 * delegated to the shared src/infra/disk-space.ts helper so this Doctor
 * check and the install/update diagnostics stay on one implementation.
 * The two-tier warning/critical thresholds and Doctor-facing formatting
 * are specific to this health contribution.
 */
export function noteDiskSpace(
  _cfg: OpenClawConfig, // reserved for API consistency with other Doctor contributions
  deps?: {
    env?: NodeJS.ProcessEnv;
    readDiskSpace?: (targetPath: string) => { availableBytes: number } | null;
  },
): void {
  const result = collectDiskSpaceWarnings({
    env: deps?.env,
    readDiskSpace: deps?.readDiskSpace,
  });
  if (!result || result.warnings.length === 0) {
    return;
  }

  note(result.warnings.join("\n"), "Disk space");
}
