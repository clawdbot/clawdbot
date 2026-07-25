// Snapshots script supports OpenClaw repository automation.
import { expectDefined } from "@openclaw/normalization-core";
import { die, run } from "./host-command.ts";
import type { Mode } from "./types.ts";
import type { SnapshotInfo } from "./types.ts";

const SNAPSHOT_LIST_TIMEOUT_MS = 120_000;
export const SKIP_SNAPSHOT_RESTORE_ENV = "OPENCLAW_PARALLELS_SKIP_SNAPSHOT_RESTORE";

export function shouldSkipSnapshotRestore(): boolean {
  return /^(1|true|yes|on)$/iu.test(process.env[SKIP_SNAPSHOT_RESTORE_ENV] ?? "");
}

export function validateSnapshotRestoreMode(mode: Mode, platform: string): void {
  if (!shouldSkipSnapshotRestore() || mode !== "both") {
    return;
  }
  die(
    `${SKIP_SNAPSHOT_RESTORE_ENV}=1 requires --mode fresh or --mode upgrade for ${platform}; --mode both would reuse the same mutated guest for both lanes`,
  );
}

export function currentRunningSnapshotInfo(vmName: string): SnapshotInfo {
  return {
    id: "current-running-vm",
    name: `current running ${vmName}`,
    state: "running",
  };
}

export function resolveSnapshot(vmName: string, hint: string): SnapshotInfo {
  const output = run("prlctl", ["snapshot-list", vmName, "--json"], {
    quiet: true,
    timeoutMs: SNAPSHOT_LIST_TIMEOUT_MS,
  }).stdout;
  if (!output.trim()) {
    die(
      `prlctl snapshot-list ${vmName} --json returned no snapshots; create/restore a snapshot or set ${SKIP_SNAPSHOT_RESTORE_ENV}=1 for an already-started guest`,
    );
  }
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

function stringSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    expectDefined(matrix[i], `snapshot similarity matrix row ${i}`)[0] = i;
  }
  const firstRow = expectDefined(matrix[0], "snapshot similarity first matrix row");
  for (let j = 0; j < cols; j++) {
    firstRow[j] = j;
  }
  for (let i = 1; i < rows; i++) {
    const row = expectDefined(matrix[i], `snapshot similarity matrix row ${i}`);
    const previousRow = expectDefined(matrix[i - 1], `snapshot similarity matrix row ${i - 1}`);
    for (let j = 1; j < cols; j++) {
      row[j] = Math.min(
        expectDefined(previousRow[j], `snapshot similarity deletion cell ${i},${j}`) + 1,
        expectDefined(row[j - 1], `snapshot similarity insertion cell ${i},${j - 1}`) + 1,
        expectDefined(
          previousRow[j - 1],
          `snapshot similarity substitution cell ${i - 1},${j - 1}`,
        ) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
      );
    }
  }
  const distance = expectDefined(
    expectDefined(matrix[a.length], "snapshot similarity final matrix row")[b.length],
    "snapshot similarity final distance",
  );
  return 1 - distance / Math.max(a.length, b.length, 1);
}
