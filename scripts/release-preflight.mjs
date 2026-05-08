#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = new Set(process.argv.slice(2));
const fix = args.has("--fix");

if (fix && args.has("--check")) {
  console.error("Use either --fix or --check, not both.");
  process.exit(1);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const fixCommands = [
  { name: "plugin versions", args: ["plugins:sync"] },
  { name: "plugin inventory", args: ["plugins:inventory:gen"] },
  { name: "base config schema", args: ["config:schema:gen"] },
  { name: "bundled channel config metadata", args: ["config:channels:gen"] },
  { name: "config docs baseline", args: ["config:docs:gen"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:sync-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:gen"] },
];

const checkCommands = [
  { name: "root dependency ownership", args: ["deps:root-ownership:check"] },
  { name: "plugin versions", args: ["plugins:sync:check"] },
  { name: "plugin inventory", args: ["plugins:inventory:check"] },
  { name: "base config schema", args: ["config:schema:check"] },
  { name: "bundled channel config metadata", args: ["config:channels:check"] },
  { name: "config docs baseline", args: ["config:docs:check"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:check-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:check"] },
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
const failed = await runAll(checkCommands);
if (failed.length !== 0) {
  printFailures("release preflight found drift", failed);
  console.error(
    "\nRun `pnpm release:prep` if the version/config/API changes are intentional, then commit the generated files.",
  );
  process.exit(1);
}
console.log("[release-preflight] OK");

async function runSerial(commands) {
  const failed = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failed.push({ ...command, status });
      break;
    }
  }
  return failed;
}

async function runAll(commands) {
  const failed = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failed.push({ ...command, status });
    }
  }
  return failed;
}

async function runCommand(command) {
  console.log(`\n[release-preflight] ${command.name}: pnpm ${command.args.join(" ")}`);
  const child = spawn(pnpm, command.args, {
    stdio: "inherit",
    shell: false,
  });
  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (status) => {
      resolve(status ?? 1);
    });
  });
}

function printFailures(title, failures) {
  console.error(`\n${title}:`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: exit ${failure.status} (pnpm ${failure.args.join(" ")})`);
  }
}
