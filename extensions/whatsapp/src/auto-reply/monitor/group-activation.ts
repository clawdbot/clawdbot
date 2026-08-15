// Whatsapp plugin module implements group activation behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { normalizeGroupActivation } from "./group-activation.runtime.js";

function hasNamedWhatsAppAccounts(cfg: OpenClawConfig) {
  const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
  return accountIds.some((accountId) => normalizeAccountId(accountId) !== DEFAULT_ACCOUNT_ID);
}

function isActivationOnlyEntry(
  entry:
    | {
        groupActivation?: unknown;
        sessionId?: unknown;
        updatedAt?: unknown;
      }
    | undefined,
) {
  return (
    entry?.groupActivation !== undefined &&
    typeof entry?.sessionId !== "string" &&
    typeof entry?.updatedAt !== "number"
  );
}

/** Resolves group activation for a WhatsApp conversation and backfills scoped session metadata. */
export async function resolveGroupActivationFor(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const sessionScope = { storePath, agentId: params.agentId };
  const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
    sessionKey: params.sessionKey,
    accountId: params.accountId,
  });
  const legacyEntry = legacySessionKey
    ? getSessionEntry({ ...sessionScope, sessionKey: legacySessionKey })
    : undefined;
  const scopedEntry = getSessionEntry({ ...sessionScope, sessionKey: params.sessionKey });
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const ignoreScopedActivation =
    normalizedAccountId === DEFAULT_ACCOUNT_ID &&
    hasNamedWhatsAppAccounts(params.cfg) &&
    isActivationOnlyEntry(scopedEntry);
  const activation =
    (ignoreScopedActivation ? undefined : scopedEntry?.groupActivation) ??
    legacyEntry?.groupActivation;
  if (activation !== undefined && scopedEntry?.groupActivation === undefined) {
    // SQLite session rows require a real session id; activation-only legacy metadata
    // can be read, but must not synthesize a scoped session just to backfill metadata.
    if (scopedEntry) {
      await patchSessionEntry({
        ...sessionScope,
        sessionKey: params.sessionKey,
        replaceEntry: true,
        update: (entry) => {
          if (entry.groupActivation !== undefined) {
            return null;
          }
          return {
            ...entry,
            groupActivation: activation,
          };
        },
      });
    }
  }
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(activation) ?? defaultActivation;
}
