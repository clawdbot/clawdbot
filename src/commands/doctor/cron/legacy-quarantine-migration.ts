/** Imports shipped cron quarantine sidecars only through the doctor migration boundary. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronQuarantinedJob } from "../../../cron/store.js";
import { parseJsonWithJson5Fallback } from "../../../utils/parse-json-compat.js";
import { archiveLegacyCronFile } from "./legacy-store-migration.js";

export type LegacyCronQuarantine = {
  path: string;
  sourceSha256: string;
  jobs: CronQuarantinedJob[];
};

/** Resolves the historical sidecar without making it part of the runtime store API. */
function resolveLegacyCronQuarantinePath(storePath: string): string {
  return storePath.endsWith(".json")
    ? storePath.replace(/\.json$/, "-quarantine.json")
    : `${storePath}-quarantine.json`;
}

/** Reads and validates a historical quarantine file without modifying its source. */
export async function loadLegacyCronQuarantineForMigration(
  storePath: string,
): Promise<LegacyCronQuarantine | undefined> {
  const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
  let raw: string;
  try {
    raw = await fs.readFile(quarantinePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = parseJsonWithJson5Fallback(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error(`Unsupported cron quarantine file shape at ${quarantinePath}`);
  }

  const jobs = parsed.jobs.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.reason !== "string" ||
      (!isRecord(entry.job) && !("raw" in entry))
    ) {
      throw new Error(`Unsupported cron quarantine entry at ${quarantinePath} index ${index}`);
    }
    const quarantined: CronQuarantinedJob = {
      quarantinedAtMs:
        typeof entry.quarantinedAtMs === "number" && Number.isFinite(entry.quarantinedAtMs)
          ? entry.quarantinedAtMs
          : Date.now(),
      sourceIndex: typeof entry.sourceIndex === "number" ? entry.sourceIndex : -1,
      reason: entry.reason,
    };
    if (isRecord(entry.job)) {
      quarantined.job = entry.job;
    }
    if ("raw" in entry) {
      quarantined.raw = entry.raw;
    }
    if (isRecord(entry.state)) {
      quarantined.state = entry.state;
    }
    if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
      quarantined.updatedAtMs = entry.updatedAtMs;
    }
    if (typeof entry.scheduleIdentity === "string") {
      quarantined.scheduleIdentity = entry.scheduleIdentity;
    }
    return quarantined;
  });

  return {
    path: quarantinePath,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    jobs,
  };
}

/** Archives the exact quarantine source already committed to SQLite. */
export async function archiveLegacyCronQuarantineForMigration(quarantine: LegacyCronQuarantine) {
  return await archiveLegacyCronFile(quarantine.path, quarantine.sourceSha256);
}
