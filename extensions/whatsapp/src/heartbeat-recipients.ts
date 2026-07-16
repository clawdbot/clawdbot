import { resolveDefaultWhatsAppAccountId, resolveWhatsAppAccount } from "./accounts.js";
import {
  DEFAULT_ACCOUNT_ID,
  loadSessionStore,
  normalizeChannelId,
  normalizeE164,
  readChannelAllowFromStoreSync,
  resolveStorePath,
  type OpenClawConfig,
} from "./heartbeat-recipients.runtime.js";

type HeartbeatRecipientsResult = { recipients: string[]; source: string };
type HeartbeatRecipientsOpts = { to?: string; all?: boolean; accountId?: string };

function getSessionRecipients(cfg: OpenClawConfig) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  if (scope === "global") {
    return [];
  }
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const isGroupKey = (key: string) =>
    key.includes(":group:") || key.includes(":channel:") || key.includes("@g.us");
  const isCronKey = (key: string) => key.startsWith("cron:");

  const recipients = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .filter(([key]) => !isGroupKey(key) && !isCronKey(key))
    .map(([_, entry]) => ({
      to:
        normalizeChannelId(entry?.lastChannel) === "whatsapp" && entry?.lastTo
          ? normalizeE164(entry.lastTo)
          : "",
      updatedAt: entry?.updatedAt ?? 0,
    }))
    .filter(({ to }) => to.length > 1)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);

  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    if (seen.has(recipient.to)) {
      return false;
    }
    seen.add(recipient.to);
    return true;
  });
}

export function resolveWhatsAppHeartbeatRecipients(
  cfg: OpenClawConfig,
  opts: HeartbeatRecipientsOpts = {},
): HeartbeatRecipientsResult {
  if (opts.to) {
    return { recipients: [normalizeE164(opts.to)], source: "flag" };
  }

  const sessionRecipients = getSessionRecipients(cfg);
  const resolvedAccountId =
    opts.accountId?.trim() || resolveDefaultWhatsAppAccountId(cfg) || DEFAULT_ACCOUNT_ID;
  const configuredAllowFrom = (
    resolveWhatsAppAccount({ cfg, accountId: resolvedAccountId }).allowFrom ?? []
  )
    .filter((value) => value !== "*")
    .map(normalizeE164);
  const storeAllowFrom = readChannelAllowFromStoreSync(
    "whatsapp",
    process.env,
    resolvedAccountId,
  ).map(normalizeE164);

  const unique = (list: string[]) => [...new Set(list.filter(Boolean))];
  const allowFrom = unique([...configuredAllowFrom, ...storeAllowFrom]);

  if (opts.all) {
    return {
      recipients: unique([...sessionRecipients.map((entry) => entry.to), ...allowFrom]),
      source: "all",
    };
  }

  if (allowFrom.length > 0) {
    const allowSet = new Set(allowFrom);
    const authorizedSessionRecipients = sessionRecipients
      .map((entry) => entry.to)
      .filter((recipient) => allowSet.has(recipient));
    if (authorizedSessionRecipients.length === 1) {
      return { recipients: [authorizedSessionRecipients[0]], source: "session-single" };
    }
    if (authorizedSessionRecipients.length > 1) {
      return { recipients: authorizedSessionRecipients, source: "session-ambiguous" };
    }
    return { recipients: allowFrom, source: "allowFrom" };
  }

  if (sessionRecipients.length === 1) {
    return { recipients: [sessionRecipients[0].to], source: "session-single" };
  }
  if (sessionRecipients.length > 1) {
    return { recipients: sessionRecipients.map((entry) => entry.to), source: "session-ambiguous" };
  }

  return { recipients: allowFrom, source: "allowFrom" };
}
