import { die, run } from "./host-command.ts";
import type { SnapshotInfo } from "./types.ts";

export function resolveSnapshot(vmName: string, hint: string): SnapshotInfo {
  const output = run("prlctl", ["snapshot-list", vmName, "--json"], { quiet: true }).stdout;
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
    return values;
  };
  const normalizedHint = hint.trim().toLowerCase();
  for (const [id, meta] of Object.entries(payload)) {
    const name = (meta.name ?? "").trim();
    if (!name) {
      continue;
    }
    let score = 0;
    for (const alias of aliases(name.toLowerCase())) {
      if (alias === normalizedHint) {
        score = Math.max(score, 10);
      } else if (normalizedHint && alias.includes(normalizedHint)) {
        score = Math.max(score, 5 + normalizedHint.length / Math.max(alias.length, 1));
      } else {
        score = Math.max(score, stringSimilarity(normalizedHint, alias));
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
