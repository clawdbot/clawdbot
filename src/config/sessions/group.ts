import type { MsgContext } from "../../auto-reply/templating.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

function normalizeGroupLabel(raw?: string) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = (params.provider?.trim().toLowerCase() || "group").trim();
  const room = params.room?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  const detail =
    (room && space
      ? `${space}${room.startsWith("#") ? "" : "#"}${room}`
      : room || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key.replace(/^group:/, "");
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.room && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  if (!from) return null;
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const isGroup =
    chatType === "group" ||
    from.startsWith("group:") ||
    from.includes("@g.us") ||
    from.includes(":group:") ||
    from.includes(":channel:");
  if (!isGroup) return null;

  const providerHint = ctx.Provider?.trim().toLowerCase();
  const hasLegacyGroupPrefix = from.startsWith("group:");
  const raw = (hasLegacyGroupPrefix ? from.slice("group:".length) : from).trim();

  let provider: string | undefined;
  let kind: "group" | "channel" | undefined;
  let id = "";

  const parseKind = (value: string) => {
    if (value === "channel") return "channel";
    return "group";
  };

  const parseParts = (parts: string[]) => {
    if (parts.length >= 2 && getGroupSurfaces().has(parts[0])) {
      provider = parts[0];
      if (parts.length >= 3) {
        const kindCandidate = parts[1];
        if (["group", "channel"].includes(kindCandidate)) {
          kind = parseKind(kindCandidate);
          id = parts.slice(2).join(":");
        } else {
          id = parts.slice(1).join(":");
        }
      } else {
        id = parts[1];
      }
      return;
    }
    if (parts.length >= 2 && ["group", "channel"].includes(parts[0])) {
      kind = parseKind(parts[0]);
      id = parts.slice(1).join(":");
    }
  };

  if (hasLegacyGroupPrefix) {
    const legacyParts = raw.split(":").filter(Boolean);
    if (legacyParts.length > 1) {
      parseParts(legacyParts);
    } else {
      id = raw;
    }
  } else if (from.includes("@g.us") && !from.includes(":")) {
    id = from;
  } else {
    parseParts(from.split(":").filter(Boolean));
    if (!id) {
      id = raw || from;
    }
  }

  const resolvedProvider = provider ?? providerHint;
  if (!resolvedProvider) {
    const legacy = hasLegacyGroupPrefix ? `group:${raw}` : `group:${from}`;
    return {
      key: legacy,
      id: raw || from,
      legacyKey: legacy,
      chatType: "group",
    };
  }

  const resolvedKind = kind === "channel" ? "channel" : "group";
  const key = `${resolvedProvider}:${resolvedKind}:${id || raw || from}`;
  let legacyKey: string | undefined;
  if (hasLegacyGroupPrefix || from.includes("@g.us")) {
    legacyKey = `group:${id || raw || from}`;
  }

  return {
    key,
    legacyKey,
    channel: resolvedProvider,
    id: id || raw || from,
    chatType: resolvedKind === "channel" ? "room" : "group",
  };
}
