import type { ControlUiPublicSessionShare } from "@openclaw/session-url-contract/public-share";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

type PublicSessionShareReadResult = {
  messages: unknown[];
  title: string;
  totalMessages: number;
  truncated: boolean;
  olderOffset?: number;
};

/** Only the exact published generation is readable; this grants no Gateway session authority. */
export async function readPublicSessionShare(
  cfg: OpenClawConfig,
  locator: ControlUiPublicSessionShare,
  options: { offset?: number } = {},
): Promise<PublicSessionShareReadResult | null> {
  const parsed = parseAgentSessionKey(locator.sessionKey);
  const fixedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, locator.sessionKey);
  if (
    (locator.sessionKey !== "global" &&
      (!parsed ||
        parsed.agentId !== locator.agentId ||
        locator.sessionKey !== `agent:${parsed.agentId}:${parsed.rest}`)) ||
    fixedOwner.kind === "retired" ||
    (fixedOwner.kind === "configured" && fixedOwner.agentId !== locator.agentId) ||
    !listAgentIds(cfg).includes(locator.agentId) ||
    isIncognitoSessionKey(locator.sessionKey)
  ) {
    return null;
  }
  const scope = {
    agentId: locator.agentId,
    sessionKey: locator.sessionKey,
    storePath: resolveSessionStorePathForScope(locator, cfg),
    projection: "list" as const,
  };
  const readAuthorizedEntry = (): InternalSessionEntry | undefined => {
    const entry = loadExactSessionEntryReadOnly(scope)?.entry;
    const share = resolveSessionPublicShare(entry);
    return share?.id === locator.shareId && share.sessionId === locator.sessionId
      ? entry
      : undefined;
  };
  const entry = readAuthorizedEntry();
  if (!entry) {
    return null;
  }
  const history = await readSessionMessagesPageWithStatsAsync(
    { ...scope, sessionId: locator.sessionId, sessionEntry: entry },
    {
      offset: options.offset ?? 0,
      maxMessages: 100,
      maxBytes: 1024 * 1024,
      allowResetArchiveFallback: false,
    },
  );
  // Revocation, replacement, or reset during history work closes this publication.
  // Never return a previously authorized payload after an awaited read without rechecking.
  const current = readAuthorizedEntry();
  if (!current) {
    return null;
  }
  const title = (current.label || current.displayName || "Shared session").trim();
  return {
    title: title || "Shared session",
    messages: history.messages,
    totalMessages: history.totalMessages,
    truncated: history.omittedOversized === true,
    ...(history.olderOffset !== undefined ? { olderOffset: history.olderOffset } : {}),
  };
}
