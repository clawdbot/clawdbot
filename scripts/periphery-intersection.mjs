#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const SHARED_LOCATION_PREFIX = "../shared/OpenClawKit/Sources/";

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--ios-results":
        options.iosResults = requireValue(args, index, option);
        index += 1;
        break;
      case "--ios-status":
        options.iosStatus = requireValue(args, index, option);
        index += 1;
        break;
      case "--macos-results":
        options.macosResults = requireValue(args, index, option);
        index += 1;
        break;
      case "--macos-status":
        options.macosStatus = requireValue(args, index, option);
        index += 1;
        break;
      case "--output":
        options.output = requireValue(args, index, option);
        index += 1;
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  for (const key of ["iosResults", "iosStatus", "macosResults", "macosStatus", "output"]) {
    if (!options[key]) {
      throw new Error(`missing required option: ${key}`);
    }
  }
  return options;
}

export function validateFindings(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} results must be a JSON array`);
  }

  return value.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`${label} finding ${index} must be an object`);
    }
    if (
      !Array.isArray(finding.ids) ||
      finding.ids.length === 0 ||
      finding.ids.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new Error(`${label} finding ${index} has no usable Swift USR`);
    }
    if (
      typeof finding.location !== "string" ||
      !finding.location.startsWith(SHARED_LOCATION_PREFIX)
    ) {
      throw new Error(`${label} finding ${index} is outside shared OpenClawKit sources`);
    }
    if (typeof finding.kind !== "string" || typeof finding.name !== "string") {
      throw new Error(`${label} finding ${index} is missing its kind or name`);
    }
    return finding;
  });
}

export function intersectFindings(iosFindings, macosFindings) {
  const ios = validateFindings(iosFindings, "iOS");
  const macos = validateFindings(macosFindings, "macOS");
  const macosIds = new Set(macos.flatMap((finding) => finding.ids));

  return ios
    .filter((finding) => finding.ids.some((id) => macosIds.has(id)))
    .toSorted((left, right) =>
      [left.location, left.kind, left.name]
        .join("\0")
        .localeCompare([right.location, right.kind, right.name].join("\0")),
    );
}

export function parseRepoLocation(location) {
  const match = /^(.*):(\d+):(\d+)$/.exec(location);
  if (!match || !match[1].startsWith("../shared/")) {
    throw new Error(`invalid shared Periphery location: ${location}`);
  }
  return {
    column: match[3],
    file: `apps/shared/${match[1].slice("../shared/".length)}`,
    line: match[2],
  };
}

export function escapeCommandData(value) {
  return String(value ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function escapeCommandProperty(value) {
  return escapeCommandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function formatAnnotation(finding) {
  const location = parseRepoLocation(finding.location);
  const title = `${finding.kind || "Unused code"} ${finding.name}`.trim();
  return `::error file=${escapeCommandProperty(location.file)},line=${location.line},col=${location.column},title=Dead shared Swift code::${escapeCommandData(title)}`;
}

export function buildSummary(findings) {
  if (findings.length === 0) {
    return [
      "### Shared OpenClawKit Periphery",
      "",
      "No declarations were reported dead by both the iOS and macOS consumer scans.",
    ].join("\n");
  }
  return [
    "### Shared OpenClawKit Periphery",
    "",
    `Found ${findings.length} shared Swift ${findings.length === 1 ? "declaration" : "declarations"} reported dead by both consumer scans.`,
    "",
    "The gate matches Periphery's Swift USRs, not declaration names.",
  ].join("\n");
}

function readStatus(file, label) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} Periphery status is invalid`);
  }
  const status = Number(raw);
  if (status !== 0) {
    throw new Error(`${label} Periphery scan exited with status ${status}`);
  }
}

function readFindings(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} Periphery results are not valid JSON`, { cause: error });
  }
  return validateFindings(parsed, label);
}

export function run(args, env = process.env) {
  const options = parseArgs(args);
  readStatus(options.iosStatus, "iOS");
  readStatus(options.macosStatus, "macOS");
  const findings = intersectFindings(
    readFindings(options.iosResults, "iOS"),
    readFindings(options.macosResults, "macOS"),
  );

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(findings, null, 2)}\n`);
  for (const finding of findings) {
    console.log(formatAnnotation(finding));
  }

  const summary = buildSummary(findings);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } else {
    console.log(summary);
  }
  return findings.length === 0 ? 0 : 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `::error title=Shared Periphery intersection failed::${escapeCommandData(message)}`,
    );
    process.exitCode = 2;
  }
}
