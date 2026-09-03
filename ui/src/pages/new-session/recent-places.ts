import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type RecentPlaceSource = {
  execCwd?: unknown;
  execNode?: unknown;
  worktree?: { repoRoot?: unknown } | null;
};

type RecentPlace = {
  folder: string;
};

export function recentPlaces(
  rows: readonly RecentPlaceSource[],
  opts: {
    workspace: string;
    allowGatewayFolder: (folder: string) => boolean;
  },
): RecentPlace[] {
  const seen = new Set<string>();
  const places: RecentPlace[] = [];

  for (const row of rows) {
    const folder =
      normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
    const execNode = normalizeOptionalString(row.execNode);
    if (!folder || execNode || folder === opts.workspace || !opts.allowGatewayFolder(folder)) {
      continue;
    }
    const key = folder;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    places.push({ folder });
    if (places.length >= 4) {
      break;
    }
  }
  return places;
}

export type { RecentPlaceSource };
