import type { TelegramGroupConfig } from "../config/types.js";
import { makeProxyFetch } from "./proxy.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export type TelegramGroupMembershipAuditEntry = {
  chatId: string;
  ok: boolean;
  status?: string | null;
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};

export type TelegramGroupMembershipAudit = {
  ok: boolean;
  checkedGroups: number;
  unresolvedGroups: number;
  hasWildcardUnmentionedGroups: boolean;
  groups: TelegramGroupMembershipAuditEntry[];
  elapsedMs: number;
};

type TelegramApiOk<T> = { ok: true; result: T };
type TelegramApiErr = { ok: false; description?: string };

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function collectTelegramUnmentionedGroupIds(
  groups: Record<string, TelegramGroupConfig> | undefined,
) {
  if (!groups || typeof groups !== "object") {
    return {
      groupIds: [] as string[],
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
    };
  }
  const hasWildcardUnmentionedGroups =
    Boolean(groups["*"]?.requireMention === false) && groups["*"]?.enabled !== false;
  const groupIds: string[] = [];
  let unresolvedGroups = 0;
  for (const [key, value] of Object.entries(groups)) {
    if (key === "*") continue;
    if (!value || typeof value !== "object") continue;
    if ((value as TelegramGroupConfig).enabled === false) continue;
    if ((value as TelegramGroupConfig).requireMention !== false) continue;
    const id = String(key).trim();
    if (!id) continue;
    if (/^-?\d+$/.test(id)) {
      groupIds.push(id);
    } else {
      unresolvedGroups += 1;
    }
  }
  groupIds.sort((a, b) => a.localeCompare(b));
  return { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups };
}

export async function auditTelegramGroupMembership(params: {
  token: string;
  botId: number;
  groupIds: string[];
  proxyUrl?: string;
  timeoutMs: number;
}): Promise<TelegramGroupMembershipAudit> {
  const started = Date.now();
  const token = params.token?.trim() ?? "";
  if (!token || params.groupIds.length === 0) {
    return {
      ok: true,
      checkedGroups: 0,
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
      groups: [],
      elapsedMs: Date.now() - started,
    };
  }

  const fetcher = params.proxyUrl ? makeProxyFetch(params.proxyUrl) : fetch;
  const base = `${TELEGRAM_API_BASE}/bot${token}`;
  const groups: TelegramGroupMembershipAuditEntry[] = [];

  for (const chatId of params.groupIds) {
    try {
      const url = `${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`;
      const res = await fetchWithTimeout(url, params.timeoutMs, fetcher);
      const json = (await res.json()) as TelegramApiOk<{ status?: string }> | TelegramApiErr;
      if (!res.ok || !isRecord(json) || json.ok !== true) {
        const desc =
          isRecord(json) && json.ok === false && typeof json.description === "string"
            ? json.description
            : `getChatMember failed (${res.status})`;
        groups.push({
          chatId,
          ok: false,
          status: null,
          error: desc,
          matchKey: chatId,
          matchSource: "id",
        });
        continue;
      }
      const status = isRecord((json as TelegramApiOk<unknown>).result)
        ? ((json as TelegramApiOk<{ status?: string }>).result.status ?? null)
        : null;
      const ok = status === "creator" || status === "administrator" || status === "member";
      groups.push({
        chatId,
        ok,
        status,
        error: ok ? null : "bot not in group",
        matchKey: chatId,
        matchSource: "id",
      });
    } catch (err) {
      groups.push({
        chatId,
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        matchKey: chatId,
        matchSource: "id",
      });
    }
  }

  return {
    ok: groups.every((g) => g.ok),
    checkedGroups: groups.length,
    unresolvedGroups: 0,
    hasWildcardUnmentionedGroups: false,
    groups,
    elapsedMs: Date.now() - started,
  };
}
