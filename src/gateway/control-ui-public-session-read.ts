import { listAgentIds } from "../agents/agent-scope-config.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { PublicSessionShareLocator } from "./control-ui-public-session-token.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

type PublicSessionShareReadResult = {
  messages: unknown[];
  title: string;
  totalMessages: number;
  truncated: boolean;
  olderOffset?: number;
};

type PublicSessionShareScope = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  projection: "list";
};

function resolvePublicSessionShareScope(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
): PublicSessionShareScope | null {
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
  return {
    agentId: locator.agentId,
    sessionKey: locator.sessionKey,
    storePath: resolveSessionStorePathForScope(locator, cfg),
    projection: "list",
  };
}

function readAuthorizedEntry(
  scope: PublicSessionShareScope,
  locator: PublicSessionShareLocator,
): InternalSessionEntry | undefined {
  const entry = loadExactSessionEntryReadOnly(scope)?.entry;
  const share = resolveSessionPublicShare(entry);
  return share?.id === locator.shareId && share.sessionId === locator.sessionId ? entry : undefined;
}

export function isPublicSessionShareActive(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
): boolean {
  const scope = resolvePublicSessionShareScope(cfg, locator);
  return Boolean(scope && readAuthorizedEntry(scope, locator));
}

/** Only the exact published generation is readable; this grants no Gateway session authority. */
export async function readPublicSessionShare(
  cfg: OpenClawConfig,
  locator: PublicSessionShareLocator,
  options: { offset?: number } = {},
): Promise<PublicSessionShareReadResult | null> {
  const scope = resolvePublicSessionShareScope(cfg, locator);
  if (!scope) {
    return null;
  }
  const entry = readAuthorizedEntry(scope, locator);
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
  const current = readAuthorizedEntry(scope, locator);
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
