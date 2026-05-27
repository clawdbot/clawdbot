#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_LIMIT = 30;

function parseArgs(argv) {
  const files = [];
  let limit = DEFAULT_LIMIT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      const raw = argv[index + 1];
      index += 1;
      const parsed = Number.parseInt(raw ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      continue;
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

function summarizeProfile(file, limit) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
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

  const durationMs = ((profile.endTime ?? 0) - (profile.startTime ?? 0)) / 1000;
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

const { files, limit } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error("usage: scripts/perf/summarize-cpuprofile.mjs [--limit N] <profile...>");
  process.exit(2);
}
for (const file of files) {
  summarizeProfile(file, limit);
}
