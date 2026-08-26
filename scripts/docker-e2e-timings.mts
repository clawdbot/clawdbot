#!/usr/bin/env node
// Summarizes Docker E2E timing artifacts.
// Accepts scheduler summary.json or lane-timings.json so agents can see the
// slowest lanes and phase critical path before deciding what to rerun.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readDockerE2eJsonArtifact } from "./lib/docker-e2e-json-artifacts.mts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";

function usage() {
  return "Usage: node --import tsx scripts/docker-e2e-timings.mts <summary.json|lane-timings.json> [--limit N]";
}

function parseArgs(argv: string[]) {
  const options = { file: "", help: false, limit: 12 };
  const readLimit = (raw: string | undefined): number => {
    if (!raw || raw.startsWith("-")) {
      throw new Error("--limit requires a value");
    }
    return parsePositiveInt(raw, "--limit");
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--limit") {
      options.limit = readLimit(argv[(index += 1)]);
    } else if (arg?.startsWith("--limit=")) {
      options.limit = readLimit(arg.slice("--limit=".length));
    } else if (arg?.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    } else if (!options.file) {
      options.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (options.help) {
    return options;
  }
  if (!options.file) {
    throw new Error(usage());
  }
  return options;
}

function readJson(file: string) {
  const value = readDockerE2eJsonArtifact(file);
  return isRecord(value) ? value : {};
}

function seconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function scalarText(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function durationBetween(startedAt: unknown, finishedAt: unknown): number {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") {
    return 0;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return 0;
  }
  return Math.round((finished - started) / 1000);
}

function summarizeSummary(summary: Record<string, unknown>, limit: number): void {
  const lanes = (Array.isArray(summary.lanes) ? summary.lanes : [])
    .filter(isRecord)
    .map((lane) => ({
      imageKind: scalarText(lane.imageKind),
      name: typeof lane.name === "string" ? lane.name : "",
      seconds: seconds(lane.elapsedSeconds),
      status: lane.status === 0 ? "pass" : `fail ${scalarText(lane.status, "unknown")}`,
      timedOut: lane.timedOut === true,
    }))
    .filter((lane) => lane.name)
    .toSorted((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
  const phases = (Array.isArray(summary.phases) ? summary.phases : [])
    .filter(isRecord)
    .map((phase) => ({
      name: typeof phase.name === "string" ? phase.name : "",
      seconds: seconds(phase.elapsedSeconds),
      status: scalarText(phase.status),
    }))
    .filter((phase) => phase.name);
  const wallSeconds = durationBetween(summary.startedAt, summary.finishedAt);
  const totalLaneSeconds = lanes.reduce((total, lane) => total + lane.seconds, 0);
  const criticalPathSeconds =
    phases.reduce((total, phase) => total + phase.seconds, 0) ||
    wallSeconds ||
    lanes[0]?.seconds ||
    0;

  console.log(`Status: ${scalarText(summary.status, "unknown")}`);
  if (wallSeconds > 0) {
    console.log(`Wall seconds: ${wallSeconds}`);
  }
  console.log(`Lane seconds total: ${totalLaneSeconds}`);
  console.log(`Approx critical path seconds: ${criticalPathSeconds}`);
  if (wallSeconds > 0 && totalLaneSeconds > 0) {
    console.log(`Approx parallelism: ${(totalLaneSeconds / wallSeconds).toFixed(1)}x`);
  }
  if (phases.length > 0) {
    console.log("");
    console.log("Phases:");
    for (const phase of phases.toSorted((left, right) => right.seconds - left.seconds)) {
      console.log(`- ${phase.name}: ${phase.seconds}s ${phase.status}`);
    }
  }
  console.log("");
  console.log(`Slowest lanes (top ${Math.min(limit, lanes.length)}):`);
  for (const lane of lanes.slice(0, limit)) {
    console.log(
      `- ${lane.name}: ${lane.seconds}s ${lane.status}${lane.timedOut ? " timeout" : ""}${
        lane.imageKind ? ` image=${lane.imageKind}` : ""
      }`,
    );
  }
}

function summarizeTimingStore(store: Record<string, unknown>, limit: number): void {
  const laneStore = isRecord(store.lanes) ? store.lanes : {};
  const lanes = Object.entries(laneStore)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, lane]) => ({
      name,
      seconds: seconds(lane.durationSeconds),
      status: lane.status === 0 ? "pass" : `fail ${scalarText(lane.status, "unknown")}`,
      updatedAt: scalarText(lane.updatedAt),
    }))
    .toSorted((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
  console.log(`Updated: ${scalarText(store.updatedAt, "unknown")}`);
  console.log(`Known lanes: ${lanes.length}`);
  console.log("");
  console.log(`Slowest lanes (top ${Math.min(limit, lanes.length)}):`);
  for (const lane of lanes.slice(0, limit)) {
    console.log(`- ${lane.name}: ${lane.seconds}s ${lane.status} ${lane.updatedAt}`.trim());
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const payload = readJson(options.file);
  if (Array.isArray(payload.lanes)) {
    summarizeSummary(payload, options.limit);
  } else if (isRecord(payload.lanes)) {
    summarizeTimingStore(payload, options.limit);
  } else {
    throw new Error(`Unsupported Docker E2E timing artifact: ${options.file}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
