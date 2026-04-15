import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_DAEMON_CLI_EXPORTS,
  resolveLegacyDaemonCliAccessors,
  resolveLegacyDaemonCliRegisterAccessor,
  resolveLegacyDaemonCliRunnerAccessors,
} from "../src/cli/daemon-cli-compat.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const cliDir = path.join(distDir, "cli");

const findCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    const isDaemonCliBundle =
      entry === "daemon-cli.js" || entry === "daemon-cli.mjs" || entry.startsWith("daemon-cli-");
    if (!isDaemonCliBundle) {
      return false;
    }
    // tsdown can emit either .js or .mjs depending on bundler settings/runtime.
    return entry.endsWith(".js") || entry.endsWith(".mjs");
  });

const findRunnerCandidates = () =>
  fs.readdirSync(distDir).filter((entry) => {
    const isRunnerBundle =
      entry === "runners.js" ||
      entry === "runners.mjs" ||
      entry.startsWith("runners-") ||
      entry === "install.runtime.js" ||
      entry === "install.runtime.mjs" ||
      entry.startsWith("install.runtime-") ||
      entry === "lifecycle.runtime.js" ||
      entry === "lifecycle.runtime.mjs" ||
      entry.startsWith("lifecycle.runtime-") ||
      entry === "status.runtime.js" ||
      entry === "status.runtime.mjs" ||
      entry.startsWith("status.runtime-");
    if (!isRunnerBundle) {
      return false;
    }
    return entry.endsWith(".js") || entry.endsWith(".mjs");
  });

// In rare cases, build output can land slightly after this script starts (depending on FS timing).
// Retry briefly to avoid flaky builds.
let candidates = findCandidates();
for (let i = 0; i < 10 && candidates.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  candidates = findCandidates();
}
let runnerCandidates = findRunnerCandidates();
for (let i = 0; i < 10 && runnerCandidates.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  runnerCandidates = findRunnerCandidates();
}

if (candidates.length === 0) {
  throw new Error("No daemon-cli bundle found in dist; cannot write legacy CLI shim.");
}

const orderedCandidates = candidates.toSorted();
const resolved = orderedCandidates
  .map((entry) => {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const accessors = resolveLegacyDaemonCliAccessors(source);
    return { entry, accessors };
  })
  .find((entry) => Boolean(entry.accessors));
const orderedRunnerCandidates = runnerCandidates.toSorted();

let daemonTarget: string;
let accessors: Partial<Record<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], string>>;
let accessorSources: Partial<Record<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], string>>;
let extraRunnerTargets: Array<{ entry: string; binding: string }>;

if (resolved?.accessors) {
  daemonTarget = resolved.entry;
  extraRunnerTargets = [];
  accessors = resolved.accessors;
  accessorSources = Object.fromEntries(
    Object.keys(resolved.accessors).map((key) => [key, "daemonCli"]),
  ) as typeof accessorSources;
} else {
  const registerResolved = orderedCandidates
    .map((entry) => {
      const source = fs.readFileSync(path.join(distDir, entry), "utf8");
      const accessor = resolveLegacyDaemonCliRegisterAccessor(source);
      return { entry, accessor };
    })
    .find((entry) => Boolean(entry.accessor));
  const runnerAccessors = new Map<
    Exclude<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], "registerDaemonCli">,
    { accessor: string; entry: string }
  >();
  for (const entry of orderedRunnerCandidates) {
    const source = fs.readFileSync(path.join(distDir, entry), "utf8");
    const resolvedAccessors = resolveLegacyDaemonCliRunnerAccessors(source);
    if (!resolvedAccessors) {
      continue;
    }
    for (const [name, accessor] of Object.entries(resolvedAccessors)) {
      if (
        !accessor ||
        runnerAccessors.has(
          name as Exclude<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], "registerDaemonCli">,
        )
      ) {
        continue;
      }
      runnerAccessors.set(
        name as Exclude<(typeof LEGACY_DAEMON_CLI_EXPORTS)[number], "registerDaemonCli">,
        { accessor, entry },
      );
    }
  }

  if (!registerResolved?.accessor || !runnerAccessors.get("runDaemonRestart")) {
    throw new Error(
      `Could not resolve daemon-cli export aliases from dist bundles: ${orderedCandidates.join(", ")} | runners: ${orderedRunnerCandidates.join(", ")}`,
    );
  }

  daemonTarget = registerResolved.entry;
  const runnerBindingByEntry = new Map<string, string>();
  extraRunnerTargets = [];
  for (const { entry } of runnerAccessors.values()) {
    if (runnerBindingByEntry.has(entry)) {
      continue;
    }
    const binding = `daemonCliRunners${runnerBindingByEntry.size}`;
    runnerBindingByEntry.set(entry, binding);
    extraRunnerTargets.push({ entry, binding });
  }
  accessors = {
    registerDaemonCli: registerResolved.accessor,
    ...Object.fromEntries(
      [...runnerAccessors.entries()].map(([name, value]) => [name, value.accessor]),
    ),
  };
  accessorSources = {
    registerDaemonCli: "daemonCli",
    runDaemonInstall: runnerAccessors.get("runDaemonInstall")
      ? runnerBindingByEntry.get(runnerAccessors.get("runDaemonInstall")!.entry)
      : undefined,
    runDaemonRestart: runnerBindingByEntry.get(runnerAccessors.get("runDaemonRestart")!.entry)!,
    runDaemonStart: runnerAccessors.get("runDaemonStart")
      ? runnerBindingByEntry.get(runnerAccessors.get("runDaemonStart")!.entry)
      : undefined,
    runDaemonStatus: runnerAccessors.get("runDaemonStatus")
      ? runnerBindingByEntry.get(runnerAccessors.get("runDaemonStatus")!.entry)
      : undefined,
    runDaemonStop: runnerAccessors.get("runDaemonStop")
      ? runnerBindingByEntry.get(runnerAccessors.get("runDaemonStop")!.entry)
      : undefined,
    runDaemonUninstall: runnerAccessors.get("runDaemonUninstall")
      ? runnerBindingByEntry.get(runnerAccessors.get("runDaemonUninstall")!.entry)
      : undefined,
  };
}

const missingExportError = (name: string) =>
  `Legacy daemon CLI export "${name}" is unavailable in this build. Please upgrade OpenClaw.`;
const buildExportLine = (name: (typeof LEGACY_DAEMON_CLI_EXPORTS)[number]) => {
  const accessor = accessors[name];
  if (accessor) {
    const sourceBinding = accessorSources[name] ?? "daemonCli";
    return `export const ${name} = ${sourceBinding}.${accessor};`;
  }
  if (name === "registerDaemonCli") {
    return `export const ${name} = () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
  }
  return `export const ${name} = async () => { throw new Error(${JSON.stringify(missingExportError(name))}); };`;
};

const contents =
  "// Legacy shim for pre-tsdown update-cli imports.\n" +
  `import * as daemonCli from "../${daemonTarget}";\n` +
  extraRunnerTargets
    .map(({ entry, binding }) => `import * as ${binding} from "../${entry}";`)
    .join("\n") +
  (extraRunnerTargets.length > 0 ? "\n" : "") +
  LEGACY_DAEMON_CLI_EXPORTS.map(buildExportLine).join("\n") +
  "\n";

fs.mkdirSync(cliDir, { recursive: true });
fs.writeFileSync(path.join(cliDir, "daemon-cli.js"), contents);
