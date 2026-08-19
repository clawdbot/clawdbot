import {
  ErrorCodes,
  errorShape,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  isPerAgentSessionStoreConfig,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { canAccessIncognitoSession, isGatewayAdmin } from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionsSearchHandler: GatewayRequestHandler = ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
    return;
  }
  const query = params.query.trim();
  if (!query) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
    return;
  }
  const resultMode = params.resultMode ?? "messages";
  if (resultMode === "messages" && (params.limit ?? 10) > 25) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "message search limit must not exceed 25"),
    );
    return;
  }
  const cfg = context.getRuntimeConfig();
  const restrictIncognito = Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
  const canSearchSessionKey = (sessionKey: string) =>
    !isIncognitoSessionKey(sessionKey) ||
    canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey });
  const scope = resolveSessionSearchScope(cfg, params);
  if (!scope.ok) {
    respond(false, undefined, scope.error);
    return;
  }
  const { agentId, configured, requestedAgentId, sessionKeys } = scope;
  if (requestedAgentId && !params.sessionKeys && configured) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
    );
    return;
  }
  const scopedSessionKeysRaw = configured
    ? sessionKeys
    : sessionKeys?.filter((sessionKey) => {
        const sessionAgentId =
          requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
            ? requestedAgentId
            : resolveSessionStoreAgentId(cfg, sessionKey);
        return sessionAgentId === agentId;
      });
  const scopedSessionKeys = scopedSessionKeysRaw?.filter(canSearchSessionKey);
  if (!configured && scopedSessionKeys?.length === 0) {
    respond(true, { results: [] }, undefined);
    return;
  }
  const existingTargets = configured
    ? []
    : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId);
  if (!configured && existingTargets.length === 0) {
    respond(true, { results: [] }, undefined);
    return;
  }
  try {
    const configuredVisibleSessionKeys =
      restrictIncognito && configured && scopedSessionKeys === undefined
        ? listSessionEntriesReadOnly({
            agentId,
            storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
          })
            .map((entry) => entry.sessionKey)
            .filter(canSearchSessionKey)
        : undefined;
    const searchTargets = configured ? [undefined] : existingTargets;
    const targetResults = searchTargets.flatMap((target) => {
      const targetSessionKeys =
        scopedSessionKeys ??
        configuredVisibleSessionKeys ??
        (target && (restrictIncognito || !isPerAgentSessionStoreConfig(cfg.session?.store))
          ? listSessionEntriesReadOnly({ agentId: target.agentId, storePath: target.storePath })
              .map((entry) => entry.sessionKey)
              .filter((sessionKey) => {
                if (!canSearchSessionKey(sessionKey)) {
                  return false;
                }
                const parsed = parseAgentSessionKey(sessionKey);
                return !parsed || normalizeAgentId(parsed.agentId) === agentId;
              })
          : undefined);
      if (targetSessionKeys?.length === 0) {
        return [];
      }
      return [
        searchSessionTranscripts({
          agentId: target?.agentId ?? agentId,
          query,
          // Over-fetch retired multi-store searches so deduplication can still fill the caller's
          // requested page when the same transcript was copied during a store migration.
          limit: configured ? params.limit : resultMode === "sessions" ? 100 : 25,
          resultMode,
          ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
          ...(target ? { storePath: target.storePath } : {}),
        }),
      ];
    });
    const limit = params.limit ?? 10;
    const sortedHits = targetResults
      .flatMap((result) => result.hits)
      .toSorted(
        (left, right) =>
          right.score - left.score ||
          right.timestamp - left.timestamp ||
          left.messageId.localeCompare(right.messageId),
      );
    const seenHits = new Set<string>();
    const hits = sortedHits.filter((hit) => {
      const identity =
        resultMode === "sessions"
          ? hit.sessionId
          : `${hit.sessionKey}\u0000${hit.sessionId}\u0000${hit.messageId}`;
      if (seenHits.has(identity)) {
        return false;
      }
      seenHits.add(identity);
      return true;
    });
    respond(true, {
      results: hits.slice(0, limit),
      ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
      ...(targetResults.some((result) => result.truncated) || hits.length > limit
        ? { truncated: true }
        : {}),
    });
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
};
