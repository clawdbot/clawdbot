#!/usr/bin/env node
// Applies GHSA patch payloads to advisory branches.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GHSA_COMMAND_TIMEOUT_MS, runGhCommand } from "./lib/ghsa-patch-subprocess.mjs";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/ghsa-patch.mjs --ghsa <GHSA-id-or-url> [--repo owner/name]",
      "    --summary <text> --severity <low|medium|high|critical>",
      "    --description-file <path>",
      "    --vulnerable-version-range <range>",
      "    --patched-versions <range-or-null>",
      "    [--package openclaw] [--ecosystem npm] [--cvss <vector>]",
    ].join("\n"),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function runGh(args) {
  try {
    return runGhCommand(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function deriveRepoFromOrigin() {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: GHSA_COMMAND_TIMEOUT_MS,
  }).trim();
  const httpsMatch = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!httpsMatch) {
    fail(`Could not parse origin remote: ${remote}`);
  }
  return `${httpsMatch[1]}/${httpsMatch[2]}`;
}

function parseGhsaId(value) {
  const match = value.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  if (!match) {
    fail(`Could not parse GHSA id from: ${value}`);
  }
  return match[0];
}

function writeTempJson(data) {
  const file = path.join(os.tmpdir(), `ghsa-patch-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

const args = parseArgs(process.argv.slice(2));
if (!args.ghsa || !args.summary || !args.severity || !args["description-file"]) {
  usage();
  process.exit(1);
}

const repo = args.repo || deriveRepoFromOrigin();
const ghsaId = parseGhsaId(args.ghsa);
const advisoryPath = `/repos/${repo}/security-advisories/${ghsaId}`;
const descriptionPath = path.resolve(args["description-file"]);

if (!fs.existsSync(descriptionPath)) {
  fail(`Description file does not exist: ${descriptionPath}`);
}

const current = JSON.parse(runGh(["api", "-H", "X-GitHub-Api-Version: 2022-11-28", advisoryPath]));
const restoredCvss = args.cvss || current?.cvss?.vector_string || null;

const ecosystem = args.ecosystem || "npm";
const packageName = args.package || "openclaw";
const vulnerableRange = args["vulnerable-version-range"];
const patchedVersionsRaw = args["patched-versions"];

if (!vulnerableRange) {
  fail("Missing --vulnerable-version-range");
}
if (patchedVersionsRaw === undefined) {
  fail("Missing --patched-versions");
}

const patchedVersions = patchedVersionsRaw === "null" ? null : patchedVersionsRaw;
const description = fs.readFileSync(descriptionPath, "utf8");

const payload = {
  summary: args.summary,
  severity: args.severity,
  description,
  vulnerabilities: [
    {
      package: {
        ecosystem,
        name: packageName,
      },
      vulnerable_version_range: vulnerableRange,
      patched_versions: patchedVersions,
      vulnerable_functions: [],
    },
  ],
};

const patchFile = writeTempJson(payload);
try {
  runGh([
    "api",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "-X",
    "PATCH",
    advisoryPath,
    "--input",
    patchFile,
  ]);
} finally {
  fs.rmSync(patchFile, { force: true });
}

if (restoredCvss) {
  runGh([
    "api",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "-X",
    "PATCH",
    advisoryPath,
    "-f",
    `cvss_vector_string=${restoredCvss}`,
  ]);
}

const refreshed = JSON.parse(
  runGh(["api", "-H", "X-GitHub-Api-Version: 2022-11-28", advisoryPath]),
);
console.log(
  JSON.stringify(
    {
      html_url: refreshed.html_url,
      state: refreshed.state,
      severity: refreshed.severity,
      summary: refreshed.summary,
      vulnerabilities: refreshed.vulnerabilities,
      cvss: refreshed.cvss,
      updated_at: refreshed.updated_at,
    },
    null,
    2,
  ),
);
