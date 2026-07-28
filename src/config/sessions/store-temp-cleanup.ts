// Session startup reclaims stale atomic-write temps without adding work to store reads.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { isSessionStoreTempArtifactName, SESSION_STORE_TEMP_STALE_MS } from "./artifacts.js";

const DELETE_CONCURRENCY = 16;

async function hasValidPrimaryStore(storePath: string): Promise<boolean> {
  try {
    return isRecord(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch {
    return false;
  }
}

/** Removes stale atomic-write temps only when the primary store is recoverable. */
export async function sweepOrphanSessionStoreTemps(params: {
  storePath: string;
  nowMs?: number;
}): Promise<number> {
  const storeDir = path.dirname(params.storePath);
  const storeBasename = path.basename(params.storePath);
  const cutoffMs = (params.nowMs ?? Date.now()) - SESSION_STORE_TEMP_STALE_MS;
  const entries = await fs.readdir(storeDir, { withFileTypes: true }).catch(() => []);
  const { results: staleCandidates } = await runTasksWithConcurrency({
    limit: DELETE_CONCURRENCY,
    tasks: entries
      .filter(
        (entry) => entry.isFile() && isSessionStoreTempArtifactName(entry.name, storeBasename),
      )
      .map((entry) => async () => {
        const candidatePath = path.join(storeDir, entry.name);
        const stat = await fs.stat(candidatePath).catch(() => null);
        if (!stat?.isFile() || stat.mtimeMs > cutoffMs) {
          return null;
        }
        return candidatePath;
      }),
  });
  const stalePaths = staleCandidates.filter(
    (candidatePath): candidatePath is string => typeof candidatePath === "string",
  );
  if (stalePaths.length === 0 || !(await hasValidPrimaryStore(params.storePath))) {
    // Avoid parsing large healthy stores on ordinary startups. If cleanup is needed, preserve
    // every candidate unless the primary parses; a temp may be the only recoverable copy.
    return 0;
  }

  const { results } = await runTasksWithConcurrency({
    limit: DELETE_CONCURRENCY,
    tasks: stalePaths.map((candidatePath) => async () => {
      try {
        await fs.unlink(candidatePath);
        return 1;
      } catch {
        // Another cleanup pass or writer may have won the race.
        return 0;
      }
    }),
  });
  let removedCount = 0;
  for (const removed of results) {
    removedCount += removed;
  }
  return removedCount;
}
