#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = path.join(rootDir, "apps", "ios", "Config", "AppStoreSigning.json");

function validateAppGroupId(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  if (!/^group\.[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error(`${context} must be an Apple app group identifier beginning with group.`);
  }
}

function usage() {
  process.stdout.write(`Usage:
  scripts/ios-release-signing.mjs --mode plan
  scripts/ios-release-signing.mjs --mode xcconfig
  scripts/ios-release-signing.mjs --mode check

Options:
  --manifest PATH   Signing manifest path. Defaults to apps/ios/Config/AppStoreSigning.json.

Fastlane owns App Store signing setup and encrypted sync. This helper only
validates the checked-in manifest and renders local release xcconfig settings.
`);
}

function parseArgs(argv) {
  let mode = "";
  let manifestPath = defaultManifestPath;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      mode = readOptionValue(argv, i, arg);
      i += 1;
    } else if (arg === "--manifest") {
      manifestPath = path.resolve(readOptionValue(argv, i, arg));
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!mode) {
    throw new Error("Missing required --mode.");
  }

  return { mode, manifestPath };
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function readManifest(manifestPath) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const requiredStrings = ["teamId", "signingRepo", "signingBranch", "profileType"];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`Signing manifest missing ${key}.`);
    }
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error("Signing manifest must include targets.");
  }
  if (parsed.appGroupId !== undefined) {
    validateAppGroupId(parsed.appGroupId, "Signing manifest appGroupId");
  }

  for (const target of parsed.targets) {
    for (const key of [
      "target",
      "displayName",
      "bundleId",
      "platform",
      "profileKey",
      "profileName",
    ]) {
      if (typeof target[key] !== "string" || target[key].trim() === "") {
        throw new Error(`Signing target is missing ${key}.`);
      }
    }
    if (!Array.isArray(target.capabilities)) {
      throw new Error(`Signing target ${target.target} must include capabilities array.`);
    }
    for (const capability of target.capabilities) {
      if (typeof capability !== "string" || capability.trim() === "") {
        throw new Error(`Signing target ${target.target} capabilities must be non-empty strings.`);
      }
    }

    const appGroups = target.appGroups ?? [];
    if (!Array.isArray(appGroups)) {
      throw new Error(`Signing target ${target.target} appGroups must be an array when present.`);
    }
    for (const appGroup of appGroups) {
      validateAppGroupId(appGroup, `Signing target ${target.target} appGroups entry`);
    }

    const hasAppGroupsCapability = target.capabilities.includes("APP_GROUPS");
    if (hasAppGroupsCapability && appGroups.length === 0) {
      throw new Error(
        `Signing target ${target.target} must list appGroups when APP_GROUPS is enabled.`,
      );
    }
    if (!hasAppGroupsCapability && appGroups.length > 0) {
      throw new Error(
        `Signing target ${target.target} lists appGroups without APP_GROUPS capability.`,
      );
    }
    if (
      typeof parsed.appGroupId === "string" &&
      appGroups.length > 0 &&
      !appGroups.includes(parsed.appGroupId)
    ) {
      throw new Error(
        `Signing target ${target.target} appGroups must include manifest appGroupId.`,
      );
    }
  }

  return parsed;
}

function writeXcconfig(manifest) {
  const lines = [
    "OPENCLAW_CODE_SIGN_STYLE = Manual",
    "OPENCLAW_CODE_SIGN_IDENTITY = Apple Distribution",
  ];
  if (typeof manifest.appGroupId === "string") {
    lines.push(`OPENCLAW_APP_GROUP_ID = ${manifest.appGroupId}`);
  }

  for (const target of manifest.targets) {
    lines.push(`${target.profileKey} = ${target.profileName}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function writePlan(manifest) {
  process.stdout.write(`iOS App Store signing plan
Team ID: ${manifest.teamId}
Profile type: ${manifest.profileType}
Signing repo: ${manifest.signingRepo}
Signing branch: ${manifest.signingBranch}
Signing setup and sync: Fastlane match

Targets:
`);
  for (const target of manifest.targets) {
    const capabilities = target.capabilities.length > 0 ? target.capabilities.join(", ") : "none";
    const appGroups =
      target.appGroups?.length > 0 ? `, app groups: ${target.appGroups.join(", ")}` : "";
    process.stdout.write(
      `- ${target.target}: ${target.bundleId}, profile "${target.profileName}", capabilities: ${capabilities}${appGroups}\n`,
    );
  }
}

try {
  const { mode, manifestPath } = parseArgs(process.argv.slice(2));
  const manifest = readManifest(manifestPath);

  if (mode === "plan") {
    writePlan(manifest);
  } else if (mode === "xcconfig") {
    writeXcconfig(manifest);
  } else if (mode === "check") {
    process.stdout.write(
      "iOS App Store signing manifest is valid. Fastlane match owns remote signing asset checks.\n",
    );
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
