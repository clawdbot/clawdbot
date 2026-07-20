#!/usr/bin/env node
// Checks or refreshes generated release artifacts before a release publish.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const parsedArgs = parseArgs(process.argv.slice(2));
const fix = parsedArgs.fix;
const macosInfoPlistPath = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
const nodeCommand = (...args) => ({ args, bin: "node" });
const pnpmCommand = (...args) => ({ args, bin: "pnpm" });
const releaseTasks = [
  {
    id: "root-dependency-ownership",
    name: "root dependency ownership",
    scopes: ["dependencies"],
    check: pnpmCommand("deps:root-ownership:check"),
  },
  {
    id: "plugin-versions",
    name: "plugin versions",
    scopes: ["plugins", "version"],
    fix: nodeCommand("--import", "tsx", "scripts/sync-plugin-versions.ts"),
    check: nodeCommand("--import", "tsx", "scripts/sync-plugin-versions.ts", "--check"),
  },
  {
    id: "npm-shrinkwraps",
    name: "npm shrinkwraps",
    scopes: ["dependencies", "plugins", "version"],
    fix: nodeCommand("scripts/generate-npm-shrinkwrap.mjs", "--changed"),
    fixAfter: ["plugin-versions", "plugin-sdk-exports"],
    check: nodeCommand("scripts/generate-npm-shrinkwrap.mjs", "--all", "--check"),
  },
  {
    id: "plugin-inventory",
    name: "plugin inventory",
    scopes: ["plugins", "version"],
    fix: nodeCommand("scripts/generate-plugin-inventory-doc.mjs", "--write"),
    fixAfter: ["plugin-versions", "plugin-sdk-exports"],
    check: nodeCommand("scripts/generate-plugin-inventory-doc.mjs", "--check"),
  },
  {
    id: "config-schema",
    name: "base config schema",
    scopes: ["config"],
    fix: pnpmCommand("config:schema:gen"),
    check: pnpmCommand("config:schema:check"),
  },
  {
    id: "channel-config",
    name: "bundled channel config metadata",
    scopes: ["config"],
    fix: pnpmCommand("config:channels:gen"),
    check: pnpmCommand("config:channels:check"),
  },
  {
    id: "config-docs",
    name: "config docs baseline",
    scopes: ["config"],
    fix: pnpmCommand("config:docs:gen"),
    fixAfter: ["config-schema", "channel-config"],
    check: pnpmCommand("config:docs:check"),
  },
  {
    id: "plugin-sdk-exports",
    name: "plugin SDK exports",
    scopes: ["plugin-sdk"],
    fix: pnpmCommand("plugin-sdk:sync-exports"),
    fixAfter: ["plugin-versions"],
    check: pnpmCommand("plugin-sdk:check-exports"),
  },
  {
    id: "plugin-sdk-api",
    name: "plugin SDK API contract manifest",
    scopes: ["plugin-sdk"],
    fix: pnpmCommand("plugin-sdk:api:gen"),
    fixAfter: ["plugin-sdk-exports"],
    check: pnpmCommand("plugin-sdk:api:check"),
  },
  {
    id: "plugin-sdk-surface",
    name: "plugin SDK surface budget",
    scopes: ["plugin-sdk"],
    check: pnpmCommand("plugin-sdk:surface:check"),
  },
  {
    id: "control-ui-i18n",
    name: "Control UI locale bundles",
    scopes: ["version"],
    fix: pnpmCommand("ui:i18n:sync"),
    check: pnpmCommand("ui:i18n:check"),
  },
  {
    id: "native-app-i18n",
    name: "native app generated locale artifacts",
    scopes: ["version"],
    check: pnpmCommand("native:i18n:check"),
  },
];
const selectedTasks = releaseTasks.filter((task) => taskMatchesScopes(task, parsedArgs.scopes));
const shouldCheckMacosVersions = parsedArgs.scopes.has("all") || parsedArgs.scopes.has("version");

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

if (fix) {
  console.log(
    `[release-preflight] refreshing generated release artifacts (${formatScopes(parsedArgs.scopes)}, jobs=${parsedArgs.jobs})`,
  );
  const fixResult = await runTaskGraph({
    commandKey: "fix",
    jobs: parsedArgs.jobs,
    tasks: selectedTasks,
  });
  if (fixResult.failed.length !== 0 || fixResult.skipped.length !== 0) {
    printFailures("release preflight refresh failed", fixResult.failed);
    printSkipped(fixResult.skipped);
    process.exit(1);
  }
}

console.log(
  `[release-preflight] checking release generated artifacts and manifests (${formatScopes(parsedArgs.scopes)}, jobs=${parsedArgs.jobs})`,
);
const macosVersionErrors = [];
if (shouldCheckMacosVersions) {
  console.log("\n[release-preflight] macOS app version metadata");
  macosVersionErrors.push(...collectMacosVersionErrors());
  if (macosVersionErrors.length === 0) {
    console.log("[release-preflight] macOS app version metadata OK");
  }
}
const { failed: checkFailures } = await runTaskGraph({
  commandKey: "check",
  jobs: parsedArgs.jobs,
  tasks: selectedTasks,
});
if (macosVersionErrors.length !== 0 || checkFailures.length !== 0) {
  console.error("\nrelease preflight found drift:");
  for (const error of macosVersionErrors) {
    console.error(`- macOS app version metadata: ${error}`);
  }
  printCommandFailures(checkFailures);
  console.error(
    "\nCorrect manual version metadata first. Run `pnpm release:prep` for intentional generated version/config/API changes, then commit the resulting files. If native locale artifacts lag, wait for or dispatch Native App Locale Refresh before freezing the release SHA.",
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

async function runTaskGraph({ commandKey, jobs, tasks }) {
  const runnableTasks = tasks
    .filter((task) => task[commandKey])
    .map((task) => {
      const command = task[commandKey];
      return {
        id: task.id,
        name: task.name,
        args: command.args,
        bin: command.bin,
        after: commandKey === "fix" ? (task.fixAfter ?? []) : [],
      };
    });
  const selectedIds = new Set(runnableTasks.map((task) => task.id));
  const pending = new Map(runnableTasks.map((task) => [task.id, task]));
  const completed = new Set();
  const failedIds = new Set();
  const taskFailures = [];
  const skipped = [];

  while (pending.size > 0) {
    for (const [taskId, task] of pending) {
      const failedDependency = task.after.find(
        (dependencyId) => selectedIds.has(dependencyId) && failedIds.has(dependencyId),
      );
      if (!failedDependency) {
        continue;
      }
      skipped.push({ ...task, dependencyId: failedDependency });
      failedIds.add(taskId);
      pending.delete(taskId);
    }

    const ready = [...pending.values()].filter((task) =>
      task.after.every(
        (dependencyId) => !selectedIds.has(dependencyId) || completed.has(dependencyId),
      ),
    );
    if (ready.length === 0) {
      if (pending.size === 0) {
        break;
      }
      throw new Error(`release preflight task graph is blocked: ${[...pending.keys()].join(", ")}`);
    }

    for (let index = 0; index < ready.length; index += jobs) {
      const batch = ready.slice(index, index + jobs);
      const results = await Promise.all(
        batch.map(async (task) => ({ task, status: await runCommand(task) })),
      );
      for (const { task, status } of results) {
        pending.delete(task.id);
        if (status === 0) {
          completed.add(task.id);
        } else {
          failedIds.add(task.id);
          taskFailures.push({ ...task, status });
        }
      }
    }
  }

  return { failed: taskFailures, skipped };
}

async function runCommand(command) {
  console.log(`\n[release-preflight] ${command.name}: ${formatCommand(command)}`);
  try {
    return await runManagedCommand({
      args: command.args,
      bin: command.bin,
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
    console.error(`- ${failure.name}: exit ${failure.status} (${formatCommand(failure)})`);
  }
}

function formatCommand(command) {
  return [command.bin, ...command.args].join(" ");
}

function printSkipped(skipped) {
  for (const task of skipped) {
    console.error(`- ${task.name}: skipped because ${task.dependencyId} failed`);
  }
}

function parseArgs(argv) {
  let check = false;
  let jobs = parseJobs(process.env.OPENCLAW_RELEASE_PREFLIGHT_JOBS ?? "4");
  let wantsFix = false;
  let macosVersionsOnly = false;
  const scopes = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    if (arg === "--jobs") {
      jobs = parseJobs(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--scope") {
      const scope = readOptionValue(argv, index, arg);
      if (!["all", "config", "dependencies", "plugin-sdk", "plugins", "version"].includes(scope)) {
        console.error(`Unknown release preflight scope: ${scope}`);
        printUsage(console.error);
        process.exit(1);
      }
      scopes.add(scope);
      index += 1;
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
  if (macosVersionsOnly && scopes.size !== 0) {
    console.error("Use --macos-versions-only without --scope.");
    process.exit(1);
  }
  if (scopes.size === 0) {
    scopes.add("all");
  }
  return { fix: wantsFix, jobs, macosVersionsOnly, scopes };
}

function printUsage(writeLine) {
  writeLine(
    "Usage: node scripts/release-preflight.mjs [--check|--fix] [--scope name] [--jobs count]",
  );
  writeLine("       node scripts/release-preflight.mjs --macos-versions-only");
  writeLine("");
  writeLine("  --check       verify generated release artifacts without writing changes (default)");
  writeLine("  --fix         refresh generated release artifacts, then verify them");
  writeLine(
    "  --scope name  all, version, dependencies, plugins, config, or plugin-sdk; repeatable",
  );
  writeLine("  --jobs count  maximum concurrent commands (default: 4)");
  writeLine("  --macos-versions-only  verify macOS source version metadata only, no commands");
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    console.error(`Missing value for ${flag}.`);
    printUsage(console.error);
    process.exit(1);
  }
  return value;
}

function parseJobs(raw) {
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    console.error(`Invalid release preflight jobs value: ${raw}; expected 1 through 16.`);
    process.exit(1);
  }
  return jobs;
}

function taskMatchesScopes(task, scopes) {
  return scopes.has("all") || task.scopes.some((scope) => scopes.has(scope));
}

function formatScopes(scopes) {
  return [...scopes].toSorted((left, right) => left.localeCompare(right)).join(",");
}
