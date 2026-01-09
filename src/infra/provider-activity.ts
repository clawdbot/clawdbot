export type ProviderId =
  | "discord"
  | "telegram"
  | "whatsapp"
  | "slack"
  | "signal"
  | "imessage"
  | "msteams";
export type ProviderDirection = "inbound" | "outbound";

type ActivityEntry = {
  inboundAt: number | null;
  outboundAt: number | null;
};

const activity = new Map<string, ActivityEntry>();

function keyFor(provider: ProviderId, accountId: string) {
  return `${provider}:${accountId || "default"}`;
}

function ensureEntry(provider: ProviderId, accountId: string): ActivityEntry {
  const key = keyFor(provider, accountId);
  const existing = activity.get(key);
  if (existing) return existing;
  const created: ActivityEntry = { inboundAt: null, outboundAt: null };
  activity.set(key, created);
  return created;
}

export function recordProviderActivity(params: {
  provider: ProviderId;
  accountId?: string | null;
  direction: ProviderDirection;
  at?: number;
}) {
  const at = typeof params.at === "number" ? params.at : Date.now();
  const accountId = params.accountId?.trim() || "default";
  const entry = ensureEntry(params.provider, accountId);
  if (params.direction === "inbound") entry.inboundAt = at;
  if (params.direction === "outbound") entry.outboundAt = at;
}

export function getProviderActivity(params: {
  provider: ProviderId;
  accountId?: string | null;
}): ActivityEntry {
  const accountId = params.accountId?.trim() || "default";
  return (
    activity.get(keyFor(params.provider, accountId)) ?? {
      inboundAt: null,
      outboundAt: null,
    }
  );
}

export function resetProviderActivityForTest() {
  activity.clear();
}
