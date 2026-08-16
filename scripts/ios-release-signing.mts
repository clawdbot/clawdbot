#!/usr/bin/env -S node --import tsx
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const rootDir = resolveRepoRoot(import.meta.url);
const defaultManifestPath = path.join(rootDir, "apps", "ios", "Config", "AppStoreSigning.json");

function validateAppGroupId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  if (!/^group\.[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error(`${context} must be an Apple app group identifier beginning with group.`);
  }
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/ios-release-signing.mjs --mode plan
  node scripts/ios-release-signing.mjs --mode xcconfig
  node scripts/ios-release-signing.mjs --mode check

Options:
  --manifest PATH   Signing manifest path. Defaults to apps/ios/Config/AppStoreSigning.json.

Fastlane owns App Store signing setup and encrypted sync. This helper only
validates the checked-in manifest and renders local release xcconfig settings.
`);
}

function parseArgs(argv: string[]) {
  const options = { manifestPath: defaultManifestPath, mode: "" };
  const helpIndex = argv.findIndex((arg) => arg === "-h" || arg === "--help");
  parseFlagArgs(
    helpIndex === -1 ? argv : argv.slice(0, helpIndex),
    options,
    [
      stringFlag("--mode", "mode", {
        allowInline: false,
        missingValueMessage: "Missing value for --mode.",
        rejectShortOptions: true,
        repeatable: true,
      }),
      stringFlag("--manifest", "manifestPath", {
        allowInline: false,
        missingValueMessage: "Missing value for --manifest.",
        rejectShortOptions: true,
        repeatable: true,
        transform: path.resolve,
      }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg) {
        throw new Error(`Unknown argument: ${arg}`);
      },
    },
  );
  if (helpIndex !== -1) {
    usage();
    process.exit(0);
  }
  if (!options.mode) {
    throw new Error("Missing required --mode.");
  }
  return options;
}

function requireString(value: unknown, message: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value;
}

function readTarget(targetValue: unknown, manifestAppGroupId: string | undefined) {
  if (!isRecord(targetValue)) {
    throw new Error("Signing target must be an object.");
  }
  const target = {
    target: requireString(targetValue.target, "Signing target is missing target."),
    displayName: requireString(targetValue.displayName, "Signing target is missing displayName."),
    bundleId: requireString(targetValue.bundleId, "Signing target is missing bundleId."),
    platform: requireString(targetValue.platform, "Signing target is missing platform."),
    profileKey: requireString(targetValue.profileKey, "Signing target is missing profileKey."),
    profileName: requireString(targetValue.profileName, "Signing target is missing profileName."),
  };
  const capabilities = targetValue.capabilities;
  if (!Array.isArray(capabilities)) {
    throw new Error(`Signing target ${target.target} must include capabilities array.`);
  }
  if (
    !capabilities.every(
      (capability): capability is string =>
        typeof capability === "string" && capability.trim() !== "",
    )
  ) {
    throw new Error(`Signing target ${target.target} capabilities must be non-empty strings.`);
  }
  const rawAppGroups = targetValue.appGroups ?? [];
  if (!Array.isArray(rawAppGroups)) {
    throw new Error(`Signing target ${target.target} appGroups must be an array when present.`);
  }
  const appGroups = rawAppGroups.map((appGroup) => {
    validateAppGroupId(appGroup, `Signing target ${target.target} appGroups entry`);
    return appGroup;
  });

  const hasAppGroupsCapability = capabilities.includes("APP_GROUPS");
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
    manifestAppGroupId !== undefined &&
    appGroups.length > 0 &&
    !appGroups.includes(manifestAppGroupId)
  ) {
    throw new Error(`Signing target ${target.target} appGroups must include manifest appGroupId.`);
  }
  return { ...target, capabilities, appGroups };
}

function readManifest(manifestPath: string) {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Signing manifest must be an object.");
  }
  const manifest = {
    teamId: requireString(parsed.teamId, "Signing manifest missing teamId."),
    signingRepo: requireString(parsed.signingRepo, "Signing manifest missing signingRepo."),
    signingBranch: requireString(parsed.signingBranch, "Signing manifest missing signingBranch."),
    profileType: requireString(parsed.profileType, "Signing manifest missing profileType."),
  };
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error("Signing manifest must include targets.");
  }
  const appGroupId = parsed.appGroupId;
  if (appGroupId !== undefined) {
    validateAppGroupId(appGroupId, "Signing manifest appGroupId");
  }
  return {
    ...manifest,
    appGroupId,
    targets: parsed.targets.map((target) => readTarget(target, appGroupId)),
  };
}

type SigningManifest = ReturnType<typeof readManifest>;

function writeXcconfig(manifest: SigningManifest) {
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

function writePlan(manifest: SigningManifest) {
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
      target.appGroups.length > 0 ? `, app groups: ${target.appGroups.join(", ")}` : "";
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
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
