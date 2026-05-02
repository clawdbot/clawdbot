import { jidToE164, normalizeE164 } from "./text-runtime.js";

const WHATSAPP_LID_RE = /@(lid|hosted\.lid)$/i;

export type WhatsAppIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
  name?: string | null;
  label?: string | null;
};

export type WhatsAppSelfIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
};

export type WhatsAppReplyContext = {
  id?: string;
  body: string;
  sender?: WhatsAppIdentity | null;
};

type LegacySenderLike = {
  sender?: WhatsAppIdentity;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
};

type LegacySelfLike = {
  self?: WhatsAppSelfIdentity;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
};

type LegacyReplyLike = {
  replyTo?: WhatsAppReplyContext;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
};

type LegacyMentionsLike = {
  mentions?: string[];
  mentionedJids?: string[];
};

function normalizeDeviceScopedJid(jid: string | null | undefined): string | null {
  return jid ? jid.replace(/:\d+/, "") : null;
}

function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid && WHATSAPP_LID_RE.test(jid));
}

export function resolveComparableIdentity(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  authDir?: string,
): WhatsAppIdentity {
  const rawJid = normalizeDeviceScopedJid(identity?.jid);
  const rawLid = normalizeDeviceScopedJid(identity?.lid);
  const lid = rawLid ?? (isLidJid(rawJid) ? rawJid : null);
  const jid = rawJid && !isLidJid(rawJid) ? rawJid : null;
  const e164 =
    identity?.e164 != null
      ? normalizeE164(identity.e164)
      : ((jid ? jidToE164(jid, authDir ? { authDir } : undefined) : null) ??
        (lid ? jidToE164(lid, authDir ? { authDir } : undefined) : null));
  return {
    ...identity,
    jid,
    lid,
    e164,
  };
}

export function getComparableIdentityValues(
  identity: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): string[] {
  const resolved = resolveComparableIdentity(identity);
  return [resolved.e164, resolved.jid, resolved.lid].filter((value): value is string =>
    Boolean(value),
  );
}

export function identitiesOverlap(
  left: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
  right: WhatsAppIdentity | WhatsAppSelfIdentity | null | undefined,
): boolean {
  const leftValues = new Set(getComparableIdentityValues(left));
  if (leftValues.size === 0) {
    return false;
  }
  return getComparableIdentityValues(right).some((value) => leftValues.has(value));
}

export function getSenderIdentity(msg: LegacySenderLike, authDir?: string): WhatsAppIdentity {
  return resolveComparableIdentity(
    msg.sender ?? {
      jid: msg.senderJid ?? null,
      e164: msg.senderE164 ?? null,
      name: msg.senderName ?? null,
    },
    authDir,
  );
}

export function getSelfIdentity(msg: LegacySelfLike, authDir?: string): WhatsAppSelfIdentity {
  return resolveComparableIdentity(
    msg.self ?? {
      jid: msg.selfJid ?? null,
      lid: msg.selfLid ?? null,
      e164: msg.selfE164 ?? null,
    },
    authDir,
  );
}

export function getReplyContext(
  msg: LegacyReplyLike,
  authDir?: string,
): WhatsAppReplyContext | null {
  if (msg.replyTo) {
    return {
      ...msg.replyTo,
      sender: resolveComparableIdentity(msg.replyTo.sender, authDir),
    };
  }
  if (!msg.replyToBody) {
    return null;
  }
  return {
    id: msg.replyToId,
    body: msg.replyToBody,
    sender: resolveComparableIdentity(
      {
        jid: msg.replyToSenderJid ?? null,
        e164: msg.replyToSenderE164 ?? null,
        label: msg.replyToSender ?? null,
      },
      authDir,
    ),
  };
}

function getMentionJids(msg: LegacyMentionsLike): string[] {
  return msg.mentions ?? msg.mentionedJids ?? [];
}

export function getMentionIdentities(
  msg: LegacyMentionsLike,
  authDir?: string,
): WhatsAppIdentity[] {
  return getMentionJids(msg).map((jid) => resolveComparableIdentity({ jid }, authDir));
}

export function getPrimaryIdentityId(identity: WhatsAppIdentity | null | undefined): string | null {
  return identity?.e164 || identity?.jid?.trim() || identity?.lid || null;
}
