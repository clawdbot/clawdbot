import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";

const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";

export type DiscordPluralKitConfig = {
  enabled?: boolean;
  token?: string;
};

export type PluralKitSystemInfo = {
  id: string;
  name?: string | null;
  tag?: string | null;
};

export type PluralKitMemberInfo = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

export type PluralKitMessageInfo = {
  id: string;
  original?: string | null;
  sender?: string | null;
  system?: PluralKitSystemInfo | null;
  member?: PluralKitMemberInfo | null;
};

export async function fetchPluralKitMessageInfo(params: {
  messageId: string;
  config?: DiscordPluralKitConfig;
  fetcher?: typeof fetch;
}): Promise<PluralKitMessageInfo | null> {
  if (!params.config?.enabled) {
    return null;
  }
  const fetchImpl = resolveFetch(params.fetcher);
  if (!fetchImpl) {
    return null;
  }
  const headers: Record<string, string> = {};
  if (params.config.token?.trim()) {
    headers.Authorization = params.config.token.trim();
  }
  const res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, {
    headers,
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = text.trim() ? `: ${text.trim()}` : "";
    throw new Error(`PluralKit API failed (${res.status})${detail}`);
  }
  return (await res.json()) as PluralKitMessageInfo;
}
