#!/usr/bin/env node
// Summarizes Docker E2E timing artifacts.
// Accepts scheduler summary.json or lane-timings.json so agents can see the
// slowest lanes and phase critical path before deciding what to rerun.
import fs from "node:fs";

function usage() {
  return "Usage: node scripts/docker-e2e-timings.mjs <summary.json|lane-timings.json> [--limit N]";
}

function parseArgs(argv) {
  const options = { file: "", limit: 12 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      options.limit = Number(argv[(index += 1)] ?? "");
    } else if (arg?.startsWith("--limit=")) {
      options.limit = Number(arg.slice("--limit=".length));
    } else if (!options.file) {
      options.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!options.file || !Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(usage());
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function durationBetween(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) {
    return 0;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return 0;
  }
  return Math.round((finished - started) / 1000);
}

function summarizeSummary(summary, limit) {
  const lanes = (Array.isArray(summary.lanes) ? summary.lanes : [])
    .map((lane) => ({
      imageKind: lane.imageKind ?? "",
      name: lane.name,
      seconds: seconds(lane.elapsedSeconds),
      status: lane.status === 0 ? "pass" : `fail ${lane.status}`,
      timedOut: lane.timedOut === true,
    }))
    .filter((lane) => lane.name)
    .toSorted((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
  const phases = (Array.isArray(summary.phases) ? summary.phases : [])
    .map((phase) => ({
      name: phase.name,
      seconds: seconds(phase.elapsedSeconds),
      status: phase.status ?? "",
    }))
    .filter((phase) => phase.name);
  const wallSeconds = durationBetween(summary.startedAt, summary.finishedAt);
  const totalLaneSeconds = lanes.reduce((total, lane) => total + lane.seconds, 0);
  const criticalPathSeconds =
    phases.reduce((total, phase) => total + phase.seconds, 0) ||
    wallSeconds ||
    lanes[0]?.seconds ||
    0;

  console.log(`Status: ${summary.status ?? "unknown"}`);
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

function summarizeTimingStore(store, limit) {
  const lanes = Object.entries(store.lanes ?? {})
    .map(([name, lane]) => ({
      name,
      seconds: seconds(lane.durationSeconds),
      status: lane.status === 0 ? "pass" : `fail ${lane.status}`,
      updatedAt: lane.updatedAt ?? "",
    }))
    .toSorted((left, right) => right.seconds - left.seconds || left.name.localeCompare(right.name));
  console.log(`Updated: ${store.updatedAt ?? "unknown"}`);
  console.log(`Known lanes: ${lanes.length}`);
  console.log("");
  console.log(`Slowest lanes (top ${Math.min(limit, lanes.length)}):`);
  for (const lane of lanes.slice(0, limit)) {
    console.log(`- ${lane.name}: ${lane.seconds}s ${lane.status} ${lane.updatedAt}`.trim());
  }
}

const options = parseArgs(process.argv.slice(2));
const payload = readJson(options.file);
if (Array.isArray(payload.lanes)) {
  summarizeSummary(payload, options.limit);
} else if (payload.lanes && typeof payload.lanes === "object") {
  summarizeTimingStore(payload, options.limit);
} else {
  throw new Error(`Unsupported Docker E2E timing artifact: ${options.file}`);
}
