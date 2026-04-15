import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { asRecord, extractCites, extractMessageText, type ParsedCite } from "./utils.js";

type TlonScryApi = {
  scry: (path: string) => Promise<unknown>;
};

export function createTlonCitationResolver(params: { api: TlonScryApi; runtime: RuntimeEnv }) {
  const { api, runtime } = params;

  const resolveCiteContent = async (cite: ParsedCite): Promise<string | null> => {
    if (cite.type !== "chan" || !cite.nest || !cite.postId) {
      return null;
    }

    try {
      const scryPath = `/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`;
      runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);

      const data = asRecord(await api.scry(scryPath));
      const essay = asRecord(data?.essay);
      if (essay?.content) {
        return extractMessageText(essay.content) || null;
      }

      return null;
    } catch (err) {
      runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
      return null;
    }
  };

  const resolveAllCites = async (content: unknown): Promise<string> => {
    const cites = extractCites(content);
    if (cites.length === 0) {
      return "";
    }

    const resolved: string[] = [];
    for (const cite of cites) {
      const text = await resolveCiteContent(cite);
      if (text) {
        resolved.push(`> ${cite.author || "unknown"} wrote: ${text}`);
      }
    }

    return resolved.length > 0 ? `${resolved.join("\n")}\n\n` : "";
  };

  return {
    resolveCiteContent,
    resolveAllCites,
  };
}
