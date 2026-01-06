import { callGateway } from "../../gateway/call.js";
import type { AnnounceTarget } from "./sessions-send-helpers.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";

export async function resolveAnnounceTarget(params: {
  sessionKey: string;
  displayKey: string;
}): Promise<AnnounceTarget | null> {
  const parsed = resolveAnnounceTargetFromKey(params.sessionKey);
  if (parsed) return parsed;
  const parsedDisplay = resolveAnnounceTargetFromKey(params.displayKey);
  if (parsedDisplay) return parsedDisplay;

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
    if (channel && to) return { channel, to };
  } catch {
    // ignore
  }

  return null;
}
