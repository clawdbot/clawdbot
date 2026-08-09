#!/usr/bin/env node
// Summarizes V8 CPU profile files by frame and module.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parsePositiveInt } from "../lib/numeric-options.mjs";

const DEFAULT_LIMIT = 30;

function usage() {
  return "Usage: scripts/perf/summarize-cpuprofile.mjs [--limit N] <profile...>";
}

export function shouldPrintHelp(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      return false;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      try {
        parsePositiveInt(value, "--limit");
      } catch {
        return false;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      try {
        parsePositiveInt(arg.slice("--limit=".length), "--limit");
      } catch {
        return false;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return true;
    }
  }
  return false;
}

/**
 * Parses CPU profile file paths and --limit.
 */
export function parseArgs(argv) {
  const files = [];
  let limit = DEFAULT_LIMIT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      limit = parsePositiveInt(argv[(index += 1)], "--limit");
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
      continue;
    }
    if (arg === "--") {
      files.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    files.push(arg);
  }
  return { files, limit };
}

function formatUrl(url) {
  if (!url) {
    return "(native)";
  }
  const cwdPrefix = `${process.cwd()}${path.sep}`;
  return url
    .replace(/^file:\/\//u, "")
    .replace(cwdPrefix, "")
    .replace(/^.*\/node_modules\//u, "node_modules/")
    .replace(/^.*\/dist\//u, "dist/");
}

function groupUrl(url) {
  const formatted = formatUrl(url);
  if (formatted.startsWith("node:")) {
    return formatted.split(":").slice(0, 2).join(":");
  }
  if (formatted.startsWith("node_modules/")) {
    return formatted.split("/").slice(0, 3).join("/");
  }
  if (formatted.startsWith("dist/")) {
    return formatted.split("/").slice(0, 2).join("/");
  }
  return formatted;
}

function add(map, key, micros) {
  map.set(key, (map.get(key) ?? 0) + micros);
}

function validateProfile(profile, file) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`${file}: CPU profile must be a JSON object`);
  }
  if (!Array.isArray(profile.nodes) || profile.nodes.length === 0) {
    throw new Error(`${file}: CPU profile has no nodes`);
  }
  if (!Array.isArray(profile.samples) || profile.samples.length === 0) {
    throw new Error(`${file}: CPU profile has no samples`);
  }
  if (
    !Number.isFinite(profile.startTime) ||
    !Number.isFinite(profile.endTime) ||
    profile.endTime <= profile.startTime
  ) {
    throw new Error(`${file}: CPU profile duration must be positive`);
  }
}

function summarizeProfile(file, limit) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  validateProfile(profile, file);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const byFrame = new Map();
  const byModule = new Map();

  for (let index = 0; index < samples.length; index += 1) {
    const node = nodes.get(samples[index]);
    if (!node) {
      continue;
    }
    const frame = node.callFrame ?? {};
    const micros = deltas[index] ?? 1000;
    const url = formatUrl(frame.url ?? "");
    const line =
      typeof frame.lineNumber === "number" && frame.lineNumber >= 0
        ? `:${frame.lineNumber + 1}`
        : "";
    const functionName = frame.functionName || "(anonymous)";
    add(byFrame, `${functionName}\t${url}${line}`, micros);
    add(byModule, groupUrl(frame.url ?? ""), micros);
  }
  if (byFrame.size === 0) {
    throw new Error(`${file}: CPU profile samples did not match profile nodes`);
  }

  const durationMs = (profile.endTime - profile.startTime) / 1000;
  console.log(`\n${file}`);
  console.log(`duration_ms: ${durationMs.toFixed(1)} samples: ${samples.length}`);
  console.log("top_frames:");
  for (const [key, micros] of [...byFrame.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, limit)) {
    console.log(`${(micros / 1000).toFixed(1)}ms\t${key}`);
  }
  console.log("top_modules:");
  for (const [key, micros] of [...byModule.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .slice(0, limit)) {
    console.log(`${(micros / 1000).toFixed(1)}ms\t${key}`);
  }
}

function main() {
  if (shouldPrintHelp(process.argv.slice(2))) {
    console.log(usage());
    return;
  }
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (options.files.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  try {
    for (const file of options.files) {
      summarizeProfile(file, options.limit);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
