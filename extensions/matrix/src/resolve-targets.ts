import type {
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
  RuntimeEnv,
} from "clawdbot/plugin-sdk";

import {
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
} from "./directory-live.js";

function pickBestGroupMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry | undefined {
  if (matches.length === 0) return undefined;
  const normalized = query.trim().toLowerCase();
  if (normalized) {
    const exact = matches.find((match) => {
      const name = match.name?.trim().toLowerCase();
      const handle = match.handle?.trim().toLowerCase();
      const id = match.id.trim().toLowerCase();
      return name === normalized || handle === normalized || id === normalized;
    });
    if (exact) return exact;
  }
  return matches[0];
}

export async function resolveMatrixTargets(params: {
  cfg: unknown;
  inputs: string[];
  kind: ChannelResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const results: ChannelResolveResult[] = [];
  for (const input of params.inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    if (params.kind === "user") {
      if (trimmed.startsWith("@") && trimmed.includes(":")) {
        results.push({ input, resolved: true, id: trimmed });
        continue;
      }
      try {
        const matches = await listMatrixDirectoryPeersLive({
          cfg: params.cfg,
          query: trimmed,
          limit: 5,
        });
        const best = matches[0];
        results.push({
          input,
          resolved: Boolean(best?.id),
          id: best?.id,
          name: best?.name,
          note: matches.length > 1 ? "multiple matches; chose first" : undefined,
        });
      } catch (err) {
        params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
        results.push({ input, resolved: false, note: "lookup failed" });
      }
      continue;
    }
    try {
      const matches = await listMatrixDirectoryGroupsLive({
        cfg: params.cfg,
        query: trimmed,
        limit: 5,
      });
      const best = pickBestGroupMatch(matches, trimmed);
      results.push({
        input,
        resolved: Boolean(best?.id),
        id: best?.id,
        name: best?.name,
        note: matches.length > 1 ? "multiple matches; chose first" : undefined,
      });
    } catch (err) {
      params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
      results.push({ input, resolved: false, note: "lookup failed" });
    }
  }
  return results;
}
