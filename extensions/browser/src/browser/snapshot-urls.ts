/**
 * Helpers for appending discovered page links to text snapshots.
 */
/** Link metadata appended to Browser page snapshots. */
export type SnapshotUrlEntry = {
  text: string;
  url: string;
};

/** Appends a compact numbered link list to a snapshot string. */
export function appendSnapshotUrls(snapshot: string, urls: readonly SnapshotUrlEntry[]): string {
  if (urls.length === 0) {
    return snapshot;
  }
  const lines = urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`);
  return `${snapshot}\n\nLinks:\n${lines.join("\n")}`;
}
