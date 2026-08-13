import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { cronStoreKey } from "./store/key.js";
import { materializeCronRowAgentOwners } from "./store/row-codec.js";

export function materializeLegacyDefaultCronJobOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  env?: NodeJS.ProcessEnv;
}): number {
  const agentId = normalizeAgentId(params.legacyDefaultAgentId);
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      materializeCronRowAgentOwners(db, cronStoreKey(path.resolve(params.storePath)), agentId),
    { env: params.env },
    { operationLabel: "cron.legacy-default-owner" },
  );
}
