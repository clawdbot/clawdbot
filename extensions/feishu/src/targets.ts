export type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id" | "union_id" | "email";

export type FeishuTarget = {
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
};

function normalizeInput(raw: string): string {
  return raw.trim().replace(/^feishu:/i, "");
}

export function parseFeishuTarget(raw: string): FeishuTarget | null {
  const trimmed = normalizeInput(raw);
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("chat:")) {
    const id = trimmed.slice("chat:".length).trim();
    return id ? { receiveIdType: "chat_id", receiveId: id } : null;
  }
  if (lowered.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? { receiveIdType: "open_id", receiveId: id } : null;
  }
  if (lowered.startsWith("open_id:")) {
    const id = trimmed.slice("open_id:".length).trim();
    return id ? { receiveIdType: "open_id", receiveId: id } : null;
  }
  if (lowered.startsWith("user_id:")) {
    const id = trimmed.slice("user_id:".length).trim();
    return id ? { receiveIdType: "user_id", receiveId: id } : null;
  }
  if (lowered.startsWith("union_id:")) {
    const id = trimmed.slice("union_id:".length).trim();
    return id ? { receiveIdType: "union_id", receiveId: id } : null;
  }
  if (lowered.startsWith("email:")) {
    const id = trimmed.slice("email:".length).trim();
    return id ? { receiveIdType: "email", receiveId: id } : null;
  }
  if (/^ou_/i.test(trimmed)) return { receiveIdType: "open_id", receiveId: trimmed };
  if (/^oc_/i.test(trimmed)) return { receiveIdType: "chat_id", receiveId: trimmed };
  return { receiveIdType: "chat_id", receiveId: trimmed };
}

export function looksLikeFeishuTargetId(raw: string): boolean {
  const trimmed = normalizeInput(raw);
  if (!trimmed) return false;
  if (/^(chat|user|open_id|user_id|union_id|email):/i.test(trimmed)) return true;
  return /^oc_/.test(trimmed) || /^ou_/.test(trimmed);
}

export function normalizeFeishuMessagingTarget(raw: string): string | undefined {
  const parsed = parseFeishuTarget(raw);
  if (!parsed) return undefined;
  if (parsed.receiveIdType === "chat_id") return `chat:${parsed.receiveId}`;
  if (parsed.receiveIdType === "open_id") return `user:${parsed.receiveId}`;
  if (parsed.receiveIdType === "user_id") return `user_id:${parsed.receiveId}`;
  if (parsed.receiveIdType === "union_id") return `union_id:${parsed.receiveId}`;
  if (parsed.receiveIdType === "email") return `email:${parsed.receiveId}`;
  return undefined;
}
