import { stripVTControlCharacters } from "node:util";
import type { CiTestTimings } from "./ci-test-timings-schema.mts";

export type CiTimingRun = {
  id: number;
  createdAt: string;
  logs: (
    | { kind: "uiE2e" | "repoE2e"; text: string }
    | { kind: "compact"; text: string; labels: string[] }
  )[];
};

type Samples = Map<string, number[]>;
const MIN_PRUNE_RUNS = 3;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function recordSample(samples: Samples, key: string, value: number) {
  if (Number.isFinite(value) && value > 0) {
    const values = samples.get(key) ?? [];
    values.push(value);
    samples.set(key, values);
  }
}

function seconds(value: string, unit: string): number {
  return Number(value) / (unit === "ms" ? 1000 : 1);
}

function readE2eLog(text: string, samples: Samples, overhead?: number[]) {
  const files = new Map<string, number>();
  for (const line of text.split("\n")) {
    const file =
      /^\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z\s+)?✓\s+(?:(?:\|ui-e2e\||ui-e2e)\s+)?(\S+\.test\.ts)\s+\((\d+) tests?(?: \| \d+ (?:skipped|todo))*\)\s+([\d.]+)(m?s)(?:\s|$)/u.exec(
        line,
      );
    if (file) {
      files.set(file[1]!, seconds(file[3]!, file[4]!));
    }
    const summary = /\bDuration\s+([\d.]+)(m?s)\s+\([^)]*\btests\s+([\d.]+)(m?s)/u.exec(line);
    if (summary && files.size > 0) {
      // Commit complete native file times, including suite hooks, once per invocation.
      for (const [name, duration] of files) {
        recordSample(samples, name, duration);
      }
      const value =
        (seconds(summary[1]!, summary[2]!) - seconds(summary[3]!, summary[4]!)) / files.size;
      if (overhead && Number.isFinite(value)) {
        overhead.push(value);
      }
      files.clear();
    }
  }
}

function readCompactLog(
  text: string,
  labels: string[],
  samples: { blacksmith: Samples; github: Samples },
) {
  const profile = labels.some((label) => label.startsWith("blacksmith-")) ? "blacksmith" : "github";
  const starts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const event =
      /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+.*?\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (!event) {
      continue;
    }
    const timestamp = event[1]!;
    const key = event[2]!;
    const action = event[3]!;
    const exitCode = event[4];
    if (action === "begin") {
      starts.set(key, Date.parse(timestamp));
      continue;
    }
    const started = starts.get(key);
    if (exitCode === "0" && started !== undefined) {
      // Preserve the workload as executed. Packed plans may be serial or
      // concurrent, and admission must use the wrapper span it actually ran.
      recordSample(samples[profile], key, (Date.parse(timestamp) - started) / 1000);
    }
    starts.delete(key);
  }
}

function refitMap(samples: Samples, previous: Record<string, number> = {}, contributingRuns = 0) {
  const next = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) => contributingRuns < MIN_PRUNE_RUNS || samples.has(key),
    ),
  );
  for (const [key, values] of samples) {
    const center = median(values);
    const retained = values.filter((value) => value <= center * 2.5);
    if (retained.length >= 2) {
      const measured = median(retained);
      if (
        previous[key] === undefined ||
        Math.abs(measured - previous[key]) > previous[key] * 0.15
      ) {
        next[key] = Math.max(1, Math.round(measured));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(next).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function refitTestTimings(runs: CiTimingRun[], previous?: CiTestTimings) {
  const samples = {
    uiE2e: new Map<string, number[]>(),
    repoE2e: new Map<string, number[]>(),
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
  };
  const contributingRuns = {
    uiE2e: new Set<number>(),
    repoE2e: new Set<number>(),
    blacksmith: new Set<number>(),
    github: new Set<number>(),
  };
  const overhead: number[] = [];
  for (const run of runs) {
    const current = {
      uiE2e: new Map<string, number[]>(),
      repoE2e: new Map<string, number[]>(),
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
    };
    for (const log of run.logs) {
      const text = stripVTControlCharacters(log.text);
      if (log.kind === "compact") {
        readCompactLog(text, log.labels, current);
      } else {
        readE2eLog(text, current[log.kind], log.kind === "uiE2e" ? overhead : undefined);
      }
    }
    // Retries or duplicate reporter lines in one run must not satisfy the two-run minimum.
    for (const profile of ["uiE2e", "repoE2e", "blacksmith", "github"] as const) {
      // Missing or unparseable profile logs are not evidence that its keys disappeared.
      if (current[profile].size > 0) {
        contributingRuns[profile].add(run.id);
      }
      for (const [key, values] of current[profile]) {
        recordSample(samples[profile], key, median(values));
      }
    }
  }

  const measuredOverhead =
    overhead.length >= 2 ? Math.max(0, Math.min(5, median(overhead))) : undefined;
  const oldOverhead = previous?.uiE2e.perFileOverheadSeconds;
  const keepOverhead =
    measuredOverhead === undefined ||
    (oldOverhead !== undefined && Math.abs(measuredOverhead - oldOverhead) <= oldOverhead * 0.15);
  const runIds = [...new Set(runs.map((run) => run.id))].toSorted((a, b) => a - b);
  const timings: CiTestTimings = {
    compactGroupSeconds: {
      blacksmith: refitMap(
        samples.blacksmith,
        previous?.compactGroupSeconds.blacksmith,
        contributingRuns.blacksmith.size,
      ),
      github: refitMap(
        samples.github,
        previous?.compactGroupSeconds.github,
        contributingRuns.github.size,
      ),
    },
    repoE2eFileSeconds: refitMap(
      samples.repoE2e,
      previous?.repoE2eFileSeconds,
      contributingRuns.repoE2e.size,
    ),
    source: `median of ${runIds.length} successful CI and release-check runs: ${runIds.join(", ")}`,
    uiE2e: {
      fileSeconds: refitMap(
        samples.uiE2e,
        previous?.uiE2e.fileSeconds,
        contributingRuns.uiE2e.size,
      ),
      perFileOverheadSeconds: keepOverhead
        ? (oldOverhead ?? 0)
        : Math.round(measuredOverhead * 10) / 10,
    },
    updatedAt:
      runs
        .map((run) => run.createdAt.slice(0, 10))
        .toSorted()
        .at(-1) ??
      previous?.updatedAt ??
      new Date().toISOString().slice(0, 10),
    version: 1,
  };
  const changes: { key: string; old: number | undefined; next: number | undefined }[] = [];
  const comparedMaps: [string, Record<string, number>, Record<string, number> | undefined][] = [
    [
      "compactGroupSeconds.blacksmith",
      timings.compactGroupSeconds.blacksmith,
      previous?.compactGroupSeconds.blacksmith,
    ],
    [
      "compactGroupSeconds.github",
      timings.compactGroupSeconds.github,
      previous?.compactGroupSeconds.github,
    ],
    ["uiE2e.fileSeconds", timings.uiE2e.fileSeconds, previous?.uiE2e.fileSeconds],
    ["repoE2eFileSeconds", timings.repoE2eFileSeconds, previous?.repoE2eFileSeconds],
    [
      "uiE2e",
      { perFileOverheadSeconds: timings.uiE2e.perFileOverheadSeconds },
      oldOverhead === undefined ? undefined : { perFileOverheadSeconds: oldOverhead },
    ],
  ];
  for (const [prefix, next, old] of comparedMaps) {
    for (const key of new Set([...Object.keys(next), ...Object.keys(old ?? {})])) {
      const value = next[key];
      const oldValue = old?.[key];
      if (value !== oldValue) {
        changes.push({ key: `${prefix}.${key}`, old: oldValue, next: value });
      }
    }
  }
  if (previous && changes.length === 0) {
    timings.source = previous.source;
    timings.updatedAt = previous.updatedAt;
  }
  return {
    timings,
    changes: changes.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    runIds,
  };
}
