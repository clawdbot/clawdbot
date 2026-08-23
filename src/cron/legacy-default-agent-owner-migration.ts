import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isMissingPathError } from "../infra/errors.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { cronStoreKey } from "./store/key.js";
import { materializeCronRowAgentOwners } from "./store/row-codec.js";

async function materializeLegacyJsonOwners(storePath: string, agentId: string): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }
  const parsed = parseJsonWithJson5Fallback(raw);
  const jobs = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : [];
  let rewritten = 0;
  for (const job of jobs) {
    if (
      !isRecord(job) ||
      normalizeOptionalString(job.agentId) ||
      parseAgentSessionKey(normalizeOptionalString(job.sessionKey))?.agentId
    ) {
      continue;
    }
    job.agentId = agentId;
    rewritten += 1;
  }
  if (rewritten === 0) {
    return 0;
  }
  await writeTextAtomic(storePath, JSON.stringify(parsed, null, 2), {
    mode: 0o600,
    tempPrefix: path.basename(storePath),
    trailingNewline: true,
    beforeRename: async () => {
      if ((await fs.readFile(storePath, "utf8")) !== raw) {
        throw new Error("legacy cron source changed while assigning its retained owner");
      }
    },
  });
  return rewritten;
}

export async function materializeLegacyDefaultCronJobOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const agentId = normalizeAgentId(params.legacyDefaultAgentId);
  const storePath = path.resolve(params.storePath);
  const sqliteCount = runOpenClawStateWriteTransaction(
    ({ db }) => materializeCronRowAgentOwners(db, cronStoreKey(storePath), agentId),
    { env: params.env },
    { operationLabel: "cron.legacy-default-owner" },
  );
  return sqliteCount + (await materializeLegacyJsonOwners(storePath, agentId));
}
