import { die, run } from "./host-command.ts";
import type { SnapshotInfo } from "./types.ts";

const SNAPSHOT_LIST_TIMEOUT_MS = 120_000;

export function resolveSnapshot(vmName: string, hint: string): SnapshotInfo {
  const output = run("prlctl", ["snapshot-list", vmName, "--json"], {
    quiet: true,
    timeoutMs: SNAPSHOT_LIST_TIMEOUT_MS,
  }).stdout;
  const payload = JSON.parse(output) as Record<string, { name?: string; state?: string }>;
  let best: SnapshotInfo | null = null;
  let bestScore = -1;
  const aliases = (name: string): string[] => {
    const values = [name];
    for (const pattern of [/^(.*)-poweroff$/, /^(.*)-poweroff-\d{4}-\d{2}-\d{2}$/]) {
      const match = name.match(pattern);
      if (match?.[1]) {
        values.push(match[1]);
      }
    }
    return values.flatMap((value) => {
      const withoutLatest = value.replace(/\s+latest$/u, "").trim();
      return withoutLatest && withoutLatest !== value ? [value, withoutLatest] : [value];
    });
  };
  const normalizedHint = hint.trim().toLowerCase();
  const normalizedHints = [normalizedHint, normalizedHint.replace(/\s+latest$/u, "").trim()].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  for (const [id, meta] of Object.entries(payload)) {
    const name = (meta.name ?? "").trim();
    if (!name) {
      continue;
    }
    let score = 0;
    for (const hintAlias of normalizedHints) {
      for (const alias of aliases(name.toLowerCase())) {
        if (alias === hintAlias) {
          score = Math.max(score, 10);
        } else if (hintAlias && alias.includes(hintAlias)) {
          score = Math.max(score, 5 + hintAlias.length / Math.max(alias.length, 1));
        } else {
          score = Math.max(score, stringSimilarity(hintAlias, alias));
        }
      }
    }
    if ((meta.state ?? "").toLowerCase() === "poweroff") {
      score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { id, name, state: (meta.state ?? "").trim() };
    }
  }
  if (!best) {
    die("no snapshot matched");
  }
  return best;
}

export function stringSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  const distance = matrix[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length, 1);
}
