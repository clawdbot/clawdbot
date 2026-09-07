import type { DiscordSourceConfig, Roster, SourceRuntime } from "../../types.js";

export const config: DiscordSourceConfig = {
  token: "synthetic-discord-secret",
  guildId: "10",
  channels: [{ id: "20", excerpts: true }],
  excerptMaxChars: 10,
  apiBaseUrl: "https://discord.com/api/v10",
};

export const window = { sinceMs: 1462015105000, untilMs: 1462015107000 };
export const roster: Roster = { members: [], byLogin: new Map(), byDiscordId: new Map() };

export function thread(id: string, archivedMs: number, type = 12) {
  return {
    id,
    parent_id: "20",
    name: "discussion",
    type,
    thread_metadata: { archive_timestamp: new Date(archivedMs).toISOString() },
  };
}

export function message(atMs: number, content = "Synthetic discussion", idOffset = 1n) {
  return {
    id: (((BigInt(atMs) - 1420070400000n) << 22n) + idOffset).toString(),
    author: { id: "30", bot: false },
    content,
    timestamp: new Date(atMs).toISOString(),
  };
}

export function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function runtime(
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
  signal?: AbortSignal,
): SourceRuntime & {
  fetchImpl: NonNullable<SourceRuntime["fetchImpl"]>;
  requests: URL[];
  logs: string[];
} {
  const requests: URL[] = [];
  const logs: string[] = [];
  const log = (text: string) => logs.push(text);
  return {
    requests,
    logs,
    signal,
    logger: { info: log, warn: log, error: log, debug: log },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push(url);
      const handled = await handler(url, init);
      if (handled) {
        return handled;
      }
      if (url.pathname === "/api/v10/guilds/10/channels") {
        return json([{ id: "20", name: "engineering", type: 0 }]);
      }
      if (url.pathname.endsWith("/threads/active")) {
        return json({ threads: [] });
      }
      if (
        url.pathname.endsWith("/threads/archived/public") ||
        url.pathname.endsWith("/threads/archived/private")
      ) {
        return json({ threads: [], has_more: false });
      }
      if (url.pathname.endsWith("/messages")) {
        return json([]);
      }
      throw new Error("Unexpected synthetic endpoint");
    },
  };
}
