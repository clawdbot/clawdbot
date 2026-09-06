#!/usr/bin/env node
// Checks or refreshes generated release artifacts before a release publish.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { coerceErrorMessage as formatError } from "./lib/error-format.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { parseReleaseVersion } from "./lib/release-version.mjs";

const macosInfoPlistPath = "apps/macos/Sources/OpenClaw/Resources/Info.plist";
type Command = { args: string[]; bin: string };
const SCOPES = ["all", "config", "dependencies", "plugin-sdk", "plugins", "version"] as const;
type Scope = (typeof SCOPES)[number];
type ReleaseTask = {
  id: string;
  name: string;
  scopes: Scope[];
  check?: Command;
  fix?: Command;
  fixAfter?: string[];
};
type RunnableTask = Command & { id: string; name: string; after: string[] };
type FailedTask = RunnableTask & { status: number };
type SkippedTask = RunnableTask & { dependencyId: string };

const nodeCommand = (...args: string[]): Command => ({ args, bin: "node" });
const pnpmCommand = (...args: string[]): Command => ({ args, bin: "pnpm" });

function isScope(value: string): value is Scope {
  return SCOPES.some((scope) => scope === value);
}
const parsedArgs = parseArgs(process.argv.slice(2));
const fix = parsedArgs.fix;
const releaseTasks: ReleaseTask[] = [
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
    id: "channel-catalog",
    name: "official channel catalog",
    scopes: ["plugins", "version"],
    fix: pnpmCommand("channels:catalog:gen"),
    fixAfter: ["plugin-versions"],
    check: pnpmCommand("channels:catalog:check"),
  },
  {
    id: "npm-package-locks",
    name: "npm package locks",
    scopes: ["dependencies", "plugins", "version"],
    check: nodeCommand("scripts/generate-npm-package-lock.mjs", "--all"),
  },
  {
    id: "plugin-inventory",
    name: "plugin inventory",
    scopes: ["plugins", "version"],
    fix: nodeCommand("--import", "tsx", "scripts/generate-plugin-inventory-doc.mts", "--write"),
    fixAfter: ["plugin-versions", "plugin-sdk-exports"],
    check: nodeCommand("--import", "tsx", "scripts/generate-plugin-inventory-doc.mts", "--check"),
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
const macosVersionErrors: string[] = [];
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
    "\nCorrect manual version metadata first. Run `pnpm release:prep` for intentional generated version/config changes, then commit the resulting files. If native locale artifacts lag, wait for or dispatch Native App Locale Refresh before freezing the release SHA.",
  );
  process.exit(1);
}
console.log("[release-preflight] OK");

function collectMacosVersionErrors(rootDir = resolve(".")): string[] {
  const packageJsonPath = resolve(rootDir, "package.json");
  const infoPlistPath = resolve(rootDir, macosInfoPlistPath);
  let packageVersion: string;
  let infoPlist: string;

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

  const errors: string[] = [];
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

function readPlistString(infoPlist: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([^<]*)</string>`, "gu");
  const matches = [...infoPlist.matchAll(pattern)];
  if (matches.length !== 1) {
    return {
      error: `${macosInfoPlistPath} must contain exactly one string value for ${key}; found ${matches.length}`,
    };
  }
  return { value: matches[0]![1]?.trim() ?? "" };
}

async function runTaskGraph({
  commandKey,
  jobs,
  tasks,
}: {
  commandKey: "fix" | "check";
  jobs: number;
  tasks: ReleaseTask[];
}) {
  const runnableTasks = tasks
    .filter((task) => task[commandKey])
    .map((task) => {
      const command = task[commandKey]!;
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
  const completed = new Set<string>();
  const failedIds = new Set<string>();
  const taskFailures: FailedTask[] = [];
  const skipped: SkippedTask[] = [];

  const running = new Map<string, Promise<{ task: RunnableTask; status: number }>>();
  while (pending.size > 0 || running.size > 0) {
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

    for (const [taskId, task] of pending) {
      if (running.size >= jobs) {
        break;
      }
      if (
        !task.after.every(
          (dependencyId) => !selectedIds.has(dependencyId) || completed.has(dependencyId),
        )
      ) {
        continue;
      }
      pending.delete(taskId);
      running.set(
        taskId,
        runCommand(task).then((status) => ({ task, status })),
      );
    }
    if (running.size === 0) {
      if (pending.size === 0) {
        break;
      }
      throw new Error(`release preflight task graph is blocked: ${[...pending.keys()].join(", ")}`);
    }

    // Refill each freed worker and release dependents without waiting for an unrelated batch.
    const { task, status } = await Promise.race(running.values());
    running.delete(task.id);
    if (status === 0) {
      completed.add(task.id);
    } else {
      failedIds.add(task.id);
      taskFailures.push({ ...task, status });
    }
  }

  return { failed: taskFailures, skipped };
}

async function runCommand(command: RunnableTask): Promise<number> {
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

function printFailures(title: string, failures: FailedTask[]): void {
  console.error(`\n${title}:`);
  printCommandFailures(failures);
}

function printCommandFailures(failures: FailedTask[]): void {
  for (const failure of failures) {
    console.error(`- ${failure.name}: exit ${failure.status} (${formatCommand(failure)})`);
  }
}

function formatCommand(command: Command): string {
  return [command.bin, ...command.args].join(" ");
}

function printSkipped(skipped: SkippedTask[]): void {
  for (const task of skipped) {
    console.error(`- ${task.name}: skipped because ${task.dependencyId} failed`);
  }
}

function parseArgs(argv: string[]) {
  let check = false;
  let jobs = parseJobs(process.env.OPENCLAW_RELEASE_PREFLIGHT_JOBS ?? "4");
  let wantsFix = false;
  let macosVersionsOnly = false;
  const scopes = new Set<Scope>();
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
      if (!isScope(scope)) {
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

function printUsage(writeLine: (line: string) => void): void {
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

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    console.error(`Missing value for ${flag}.`);
    printUsage(console.error);
    process.exit(1);
  }
  return value;
}

function parseJobs(raw: string): number {
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) {
    console.error(`Invalid release preflight jobs value: ${raw}; expected 1 through 16.`);
    process.exit(1);
  }
  return jobs;
}

function taskMatchesScopes(task: ReleaseTask, scopes: Set<Scope>): boolean {
  return scopes.has("all") || task.scopes.some((scope) => scopes.has(scope));
}

function formatScopes(scopes: Set<Scope>): string {
  return [...scopes].toSorted((left, right) => left.localeCompare(right)).join(",");
}
