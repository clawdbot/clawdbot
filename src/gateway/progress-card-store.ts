import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveGatewaySessionDatabase } from "./board-store.js";

export type ProgressCardStore = {
  get(sessionKey: string): ProgressCard | null;
  put(
    sessionKey: string,
    input: { markdown?: string; steps?: ProgressCardStep[]; expectedRevision?: number },
  ): { card: ProgressCard | null };
};

export const progressCardStore: ProgressCardStore = {
  get(sessionKey) {
    const resolved = resolveGatewaySessionDatabase(sessionKey);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionProgressCard(database.db, resolved.sessionKey),
      resolved,
    );
    return result.found ? result.value : null;
  },
  put(sessionKey, input) {
    const resolved = resolveGatewaySessionDatabase(sessionKey);
    const result = runOpenClawAgentWriteTransaction(
      (transactionDatabase) =>
        writeSessionProgressCard(transactionDatabase.db, resolved.sessionKey, input),
      resolved,
      { operationLabel: "progress-card.put" },
    );
    return "card" in result ? result : { card: null };
  },
};
