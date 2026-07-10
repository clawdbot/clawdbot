#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyStableMainCloseout } from "./lib/stable-release-closeout.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`${key} requires a value.`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }

  const required = [
    "tag",
    "main-dir",
    "tag-dir",
    "release-json",
    "full-release-validation-run-id",
    "full-release-validation-run-attempt",
    "release-publish-run-id",
    "rollback-drill-id",
    "rollback-drill-date",
    "output",
  ];
  for (const key of required) {
    if (!values.has(key)) {
      throw new Error(`--${key} is required.`);
    }
  }
  return Object.fromEntries(values);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function gitSha(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mainDir = resolve(args["main-dir"]);
  const tagDir = resolve(args["tag-dir"]);
  const result = verifyStableMainCloseout({
    tag: args.tag,
    mainPackageJson: readJson(resolve(mainDir, "package.json")),
    tagPackageJson: readJson(resolve(tagDir, "package.json")),
    mainChangelog: readFileSync(resolve(mainDir, "CHANGELOG.md"), "utf8"),
    tagChangelog: readFileSync(resolve(tagDir, "CHANGELOG.md"), "utf8"),
    mainAppcast: readFileSync(resolve(mainDir, "appcast.xml"), "utf8"),
    release: readJson(resolve(args["release-json"])),
    releaseTagSha: gitSha(tagDir),
    mainSha: gitSha(mainDir),
    fullReleaseValidationRunId: args["full-release-validation-run-id"],
    fullReleaseValidationRunAttempt: args["full-release-validation-run-attempt"],
    releasePublishRunId: args["release-publish-run-id"],
    rollbackDrillId: args["rollback-drill-id"],
    rollbackDrillDate: args["rollback-drill-date"],
    allowStaleRollbackDrill: args["allow-stale-rollback-drill"] === "true",
    nowMs: Date.now(),
  });
  if (result.errors.length > 0 || !result.manifest) {
    throw new Error(`stable main closeout failed:\n- ${result.errors.join("\n- ")}`);
  }

  writeFileSync(resolve(args.output), `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`stable main closeout verified: ${args.tag}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
