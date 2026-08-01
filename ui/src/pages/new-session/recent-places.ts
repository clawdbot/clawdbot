import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import type { DraftNode } from "./discovery.ts";

type RecentPlaceSource = {
  execCwd?: unknown;
  execNode?: unknown;
  worktree?: { repoRoot?: unknown } | null;
};

type RecentPlace = {
  folder: string;
  execNode: string;
};

export function recentPlaces(
  rows: readonly RecentPlaceSource[],
  opts: {
    workspace: string;
    execNodes: readonly Pick<DraftNode, "nodeId">[];
  },
): RecentPlace[] {
  const knownNodes = new Set(opts.execNodes.map((node) => node.nodeId));
  const seen = new Set<string>();
  const places: RecentPlace[] = [];

  for (const row of rows) {
    const folder =
      normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
    const execNode = normalizeOptionalString(row.execNode) ?? "";
    if (
      !folder ||
      (folder === opts.workspace && !execNode) ||
      (execNode && !knownNodes.has(execNode))
    ) {
      continue;
    }
    const key = `${execNode}\0${folder}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    places.push({ folder, execNode });
    if (places.length >= 4) {
      break;
    }
  }
  return places;
}

export type { RecentPlaceSource };
