import {
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  const fallback = parsed ?? parsedDisplay ?? null;

  if (fallback) {
    const normalized = normalizeChannelId(fallback.channel);
    const plugin = normalized ? getChannelPlugin(normalized) : null;
    if (!plugin?.meta?.preferSessionLookupForAnnounceTarget) {
      return fallback;
    }
  }

  try {
    const list = (await callGateway({
      method: "sessions.list",
      params: {
        includeGlobal: true,
        includeUnknown: true,
        limit: 200,
      },
    })) as { sessions?: Array<Record<string, unknown>> };
    const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
    const match =
      sessions.find((entry) => entry?.key === params.sessionKey) ??
      sessions.find((entry) => entry?.key === params.displayKey);
    const channel =
      typeof match?.lastChannel === "string" ? match.lastChannel : undefined;
    const to = typeof match?.lastTo === "string" ? match.lastTo : undefined;
    const accountId =
      typeof match?.lastAccountId === "string"
        ? match.lastAccountId
        : undefined;
    if (channel && to) return { channel, to, accountId };
  } catch {
    // ignore
  }

  return fallback;
}
