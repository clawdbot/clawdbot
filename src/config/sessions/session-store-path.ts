import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { getRuntimeConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";

type SessionStorePathScope = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey?: string;
  storePath?: string;
};

export function resolveSessionStorePathForScope(scope: SessionStorePathScope): string {
  // The incognito-* key segment is reserved: key shape wins over any supplied
  // durable store path so stale keys can never fall through to disk. Legacy
  // durable rows that collide are doctor-owned (`doctor-session-incognito-key-repair`);
  // no runtime fallback by design.
  if (isIncognitoSessionKey(scope.sessionKey)) {
    return resolveIncognitoOpenClawAgentSqlitePath({
      agentId: resolveAgentIdFromSessionKey(scope.sessionKey),
      env: scope.env,
    });
  }
  if (scope.storePath) {
    return scope.storePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveStorePath(getRuntimeConfig().session?.store, {
    agentId,
    env: scope.env,
  });
}
