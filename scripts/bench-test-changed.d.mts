export function parseArgs(argv: unknown): {
  maxWorkers?: unknown;
  cwd: string;
  mode: unknown;
  ref: unknown;
  rss: unknown;
};
export function parseMaxRssBytes(output: unknown): number | null;
export function formatRss(valueBytes: unknown): string;
export function resolveBenchRssResult({
  label,
  output,
  rss,
  status,
}: {
  label: unknown;
  output: unknown;
  rss: unknown;
  status: unknown;
}): {
  maxRssBytes: number | null;
  output: unknown;
  status: unknown;
};
