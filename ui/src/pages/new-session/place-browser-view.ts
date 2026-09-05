import type {
  FsDirEntry,
  FsListDirResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { isAbsolutePath, sameAbsolutePath } from "./path.ts";

export function splitBrowserDraft(draft: string): { directory: string; prefix: string } | null {
  if (!isAbsolutePath(draft)) {
    return null;
  }
  const rootLength = /^[A-Za-z]:[\\/]/u.test(draft) ? 3 : 1;
  const trailingSeparator = draft.search(/[\\/]+$/u);
  if (trailingSeparator >= 0) {
    return {
      directory: draft.slice(0, Math.max(rootLength, trailingSeparator)),
      prefix: "",
    };
  }
  const separator = Math.max(draft.lastIndexOf("/"), draft.lastIndexOf("\\"));
  return {
    directory: draft.slice(0, Math.max(rootLength, separator)),
    prefix: draft.slice(separator + 1),
  };
}

function filterBrowserEntries(entries: readonly FsDirEntry[], prefix: string): FsDirEntry[] {
  if (!prefix) {
    return [...entries];
  }
  const query = prefix.toLowerCase();
  // Case-sensitive filesystems can hold `App` and `app`; the typed spelling must win first.
  const spelled: FsDirEntry[] = [];
  const exact: FsDirEntry[] = [];
  const starts: FsDirEntry[] = [];
  const contains: FsDirEntry[] = [];
  for (const entry of entries) {
    // A leading dot opts into hidden folders while filtering.
    if (entry.hidden && !prefix.startsWith(".")) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (entry.name === prefix) {
      spelled.push(entry);
    } else if (name === query) {
      exact.push(entry);
    } else if (name.startsWith(query)) {
      starts.push(entry);
    } else if (name.includes(query)) {
      contains.push(entry);
    }
  }
  return [...spelled, ...exact, ...starts, ...contains];
}

export function resolvePlaceBrowserView(params: {
  listing: FsListDirResult | null;
  draft: string;
  loading: boolean;
}): { entries: FsDirEntry[]; empty: "none" | "no-subfolders" | "no-matches" } {
  const { listing, draft, loading } = params;
  const split = splitBrowserDraft(draft);
  if ((listing && sameAbsolutePath(draft, listing.path)) || !split) {
    const entries = listing?.entries ?? [];
    return {
      entries,
      empty: listing && entries.length === 0 && !loading ? "no-subfolders" : "none",
    };
  }
  if (listing && sameAbsolutePath(split.directory, listing.path)) {
    const entries = filterBrowserEntries(listing.entries, split.prefix);
    return {
      entries,
      empty:
        entries.length === 0 && !loading ? (split.prefix ? "no-matches" : "no-subfolders") : "none",
    };
  }
  return { entries: [], empty: loading ? "none" : "no-matches" };
}
