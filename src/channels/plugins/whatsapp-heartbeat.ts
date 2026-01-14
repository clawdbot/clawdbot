import { normalizeChatChannelId } from "../../channels/registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { normalizeE164 } from "../../utils.js";

type HeartbeatRecipientsResult = { recipients: string[]; source: string };
type HeartbeatRecipientsOpts = { to?: string; all?: boolean };

function getSessionRecipients(cfg: ClawdbotConfig) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  if (scope === "global") return [];
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const isGroupKey = (key: string) =>
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:") ||
    key.includes("@g.us");
  const isCronKey = (key: string) => key.startsWith("cron:");

  const recipients = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .filter(([key]) => !isGroupKey(key) && !isCronKey(key))
    .map(([_, entry]) => ({
      to:
        normalizeChatChannelId(entry?.lastChannel) === "whatsapp" &&
        entry?.lastTo
          ? normalizeE164(entry.lastTo)
          : "",
      updatedAt: entry?.updatedAt ?? 0,
    }))
    .filter(({ to }) => to.length > 1)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Dedupe while preserving recency ordering.
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.to)) return false;
    seen.add(r.to);
    return true;
  });
}

export function resolveWhatsAppHeartbeatRecipients(
  cfg: ClawdbotConfig,
  opts: HeartbeatRecipientsOpts = {},
): HeartbeatRecipientsResult {
  if (opts.to) {
    return { recipients: [normalizeE164(opts.to)], source: "flag" };
  }

  const sessionRecipients = getSessionRecipients(cfg);
  const allowFrom =
    Array.isArray(cfg.channels?.whatsapp?.allowFrom) &&
    cfg.channels.whatsapp.allowFrom.length > 0
      ? cfg.channels.whatsapp.allowFrom
          .filter((v) => v !== "*")
          .map(normalizeE164)
      : [];

  const unique = (list: string[]) => [...new Set(list.filter(Boolean))];

  if (opts.all) {
    const all = unique([...sessionRecipients.map((s) => s.to), ...allowFrom]);
    return { recipients: all, source: "all" };
  }

  if (sessionRecipients.length === 1) {
    return { recipients: [sessionRecipients[0].to], source: "session-single" };
  }
  if (sessionRecipients.length > 1) {
    return {
      recipients: sessionRecipients.map((s) => s.to),
      source: "session-ambiguous",
    };
  }

  return { recipients: allowFrom, source: "allowFrom" };
}
