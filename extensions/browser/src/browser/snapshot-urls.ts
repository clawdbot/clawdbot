export type SnapshotUrlEntry = {
  text: string;
  url: string;
};

export function appendSnapshotUrls(snapshot: string, urls: readonly SnapshotUrlEntry[]): string {
  if (urls.length === 0) {
    return snapshot;
  }
  const lines = urls.map((entry, index) => `${index + 1}. ${entry.text} -> ${entry.url}`);
  return `${snapshot}\n\nLinks:\n${lines.join("\n")}`;
}
