#!/usr/bin/env node
// Checks or refreshes generated release artifacts before a release publish.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const parsedArgs = parseArgs(process.argv.slice(2));
const fix = parsedArgs.fix;
const macosInfoPlistPath = "apps/macos/Sources/OpenClaw/Resources/Info.plist";

// Release-evidence reuse validates version-stamp targets without running any
// package-manager commands; keep this mode dependency-free file reads only.
if (parsedArgs.macosVersionsOnly) {
  const errors = collectMacosVersionErrors();
  if (errors.length !== 0) {
    for (const error of errors) {
      console.error(`[release-preflight] macOS app version metadata: ${error}`);
    }
    process.exit(1);
  }
  console.log("[release-preflight] macOS app version metadata OK");
  process.exit(0);
}

const fixCommands = [
  { name: "plugin versions", args: ["plugins:sync"] },
  { name: "npm shrinkwraps", args: ["deps:shrinkwrap:changed:generate"] },
  { name: "plugin inventory", args: ["plugins:inventory:gen"] },
  { name: "base config schema", args: ["config:schema:gen"] },
  { name: "bundled channel config metadata", args: ["config:channels:gen"] },
  { name: "config docs baseline", args: ["config:docs:gen"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:sync-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:gen"] },
];

const checkCommands = [
  { name: "root dependency ownership", args: ["deps:root-ownership:check"] },
  { name: "npm shrinkwraps", args: ["deps:shrinkwrap:check"] },
  { name: "plugin versions", args: ["plugins:sync:check"] },
  { name: "plugin inventory", args: ["plugins:inventory:check"] },
  { name: "base config schema", args: ["config:schema:check"] },
  { name: "bundled channel config metadata", args: ["config:channels:check"] },
  { name: "config docs baseline", args: ["config:docs:check"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:check-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:check"] },
  { name: "plugin SDK surface budget", args: ["plugin-sdk:surface:check"] },
];

if (fix) {
  console.log("[release-preflight] refreshing generated release artifacts");
  const failed = await runSerial(fixCommands);
  if (failed.length !== 0) {
    printFailures("release preflight refresh failed", failed);
    process.exit(1);
  }
}

console.log("[release-preflight] checking release generated artifacts and manifests");
console.log("\n[release-preflight] macOS app version metadata");
const macosVersionErrors = collectMacosVersionErrors();
if (macosVersionErrors.length === 0) {
  console.log("[release-preflight] macOS app version metadata OK");
}
const failed = await runAll(checkCommands);
if (macosVersionErrors.length !== 0 || failed.length !== 0) {
  console.error("\nrelease preflight found drift:");
  for (const error of macosVersionErrors) {
    console.error(`- macOS app version metadata: ${error}`);
  }
  printCommandFailures(failed);
  console.error(
    "\nCorrect manual version metadata first. Run `pnpm release:prep` for intentional generated version/config/API changes, then commit the resulting files.",
  );
  process.exit(1);
}
console.log("[release-preflight] OK");

function collectMacosVersionErrors(rootDir = resolve(".")) {
  const packageJsonPath = resolve(rootDir, "package.json");
  const infoPlistPath = resolve(rootDir, macosInfoPlistPath);
  let packageVersion;
  let infoPlist;

  try {
    const parsedPackage = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageVersion = typeof parsedPackage.version === "string" ? parsedPackage.version.trim() : "";
  } catch (error) {
    return [`unable to read package.json: ${formatError(error)}`];
  }

  const releaseVersion = parseReleaseVersion(packageVersion);
  if (!releaseVersion) {
    return [`package.json has invalid release version ${JSON.stringify(packageVersion)}`];
  }

  try {
    infoPlist = readFileSync(infoPlistPath, "utf8");
  } catch (error) {
    return [`unable to read ${macosInfoPlistPath}: ${formatError(error)}`];
  }

  const errors = [];
  // The source plist tracks native base metadata. Packaging stamps the exact
  // prerelease version and canonical Sparkle build into the copied app bundle.
  const expectedShortVersion = releaseVersion.baseVersion;
  const expectedBuildVersion = [
    String(releaseVersion.year),
    String(releaseVersion.month).padStart(2, "0"),
    String(releaseVersion.patch).padStart(2, "0"),
    "00",
  ].join("");
  const shortVersion = readPlistString(infoPlist, "CFBundleShortVersionString");
  const buildVersion = readPlistString(infoPlist, "CFBundleVersion");

  if (shortVersion.error) {
    errors.push(shortVersion.error);
  } else if (shortVersion.value !== expectedShortVersion) {
    errors.push(
      `${macosInfoPlistPath} CFBundleShortVersionString is ${JSON.stringify(shortVersion.value)}; expected ${JSON.stringify(expectedShortVersion)} from package.json base version`,
    );
  }

  if (buildVersion.error) {
    errors.push(buildVersion.error);
  } else if (buildVersion.value !== expectedBuildVersion) {
    errors.push(
      `${macosInfoPlistPath} CFBundleVersion is ${JSON.stringify(buildVersion.value)}; expected ${JSON.stringify(expectedBuildVersion)} for ${expectedShortVersion}`,
    );
  }

  return errors;
}

function readPlistString(infoPlist, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]*)</string>`, "gu");
  const matches = [...infoPlist.matchAll(pattern)];
  if (matches.length !== 1) {
    return {
      error: `${macosInfoPlistPath} must contain exactly one string value for ${key}; found ${matches.length}`,
    };
  }
  return { value: matches[0][1]?.trim() ?? "" };
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runSerial(commands) {
  const failedValue = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failedValue.push({ ...command, status });
      break;
    }
  }
  return failedValue;
}

async function runAll(commands) {
  const failedLocal = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failedLocal.push({ ...command, status });
    }
  }
  return failedLocal;
}

async function runCommand(command) {
  console.log(`\n[release-preflight] ${command.name}: pnpm ${command.args.join(" ")}`);
  try {
    return await runManagedCommand({
      args: command.args,
      bin: "pnpm",
    });
  } catch (error) {
    console.error(error);
    return 1;
  }
}

function printFailures(title, failures) {
  console.error(`\n${title}:`);
  printCommandFailures(failures);
}

function printCommandFailures(failures) {
  for (const failure of failures) {
    console.error(`- ${failure.name}: exit ${failure.status} (pnpm ${failure.args.join(" ")})`);
  }
}

function parseArgs(argv) {
  let check = false;
  let wantsFix = false;
  let macosVersionsOnly = false;
  for (const arg of argv) {
    if (arg === "--help") {
      printUsage(console.log);
      process.exit(0);
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--fix") {
      wantsFix = true;
      continue;
    }
    if (arg === "--macos-versions-only") {
      macosVersionsOnly = true;
      continue;
    }
    console.error(`Unknown release preflight argument: ${arg}`);
    printUsage(console.error);
    process.exit(1);
  }
  if (wantsFix && check) {
    console.error("Use either --fix or --check, not both.");
    process.exit(1);
  }
  if (macosVersionsOnly && (wantsFix || check)) {
    console.error("Use --macos-versions-only without --fix or --check.");
    process.exit(1);
  }
  return { fix: wantsFix, macosVersionsOnly };
}

function printUsage(writeLine) {
  writeLine("Usage: node scripts/release-preflight.mjs [--check|--fix|--macos-versions-only]");
  writeLine("");
  writeLine("  --check  verify generated release artifacts without writing changes (default)");
  writeLine("  --fix    refresh generated release artifacts, then verify them");
  writeLine("  --macos-versions-only  verify macOS source version metadata only, no commands");
}
