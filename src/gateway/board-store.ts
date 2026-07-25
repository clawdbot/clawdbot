import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";

export const boardStore = new SqliteBoardStore({
  resolveSession: (sessionKey) => {
    const cfg = getRuntimeConfig();
    const canonicalSessionKey = resolveSessionStoreKey({ cfg, sessionKey });
    const agentId = resolveSessionStoreAgentId(cfg, canonicalSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
    return {
      agentId,
      ...(databasePath ? { path: databasePath } : {}),
      sessionKey: canonicalSessionKey,
    };
  },
});
