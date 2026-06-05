#!/usr/bin/env -S node --import tsx
// Test Force script supports OpenClaw repository automation.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forceFreePort, type PortProcess } from "../src/cli/ports.js";
import { resolveGatewayPort } from "../src/config/config.js";

function usage(): string {
  return [
    "Usage: node --import tsx scripts/test-force.ts",
    "",
    "Clears the configured OpenClaw gateway port, then runs the local test suite.",
    "",
    "Options:",
    "  -h, --help    Show this help.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): { help: boolean } {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
  }
  return { help: false };
}

export const testForceTesting = {
  parseArgs,
  usage,
};

function killGatewayListeners(port: number): PortProcess[] {
  try {
    const killed = forceFreePort(port);
    if (killed.length > 0) {
      console.log(
        `freed port ${port}; terminated: ${killed
          .map((p) => `${p.command} (pid ${p.pid})`)
          .join(", ")}`,
      );
    } else {
      console.log(`port ${port} already free`);
    }
    return killed;
  } catch (err) {
    console.error(`failed to free port ${port}: ${String(err)}`);
    return [];
  }
}

function runTests() {
  const isolatedLock =
    process.env.OPENCLAW_GATEWAY_LOCK ??
    path.join(os.tmpdir(), `openclaw-gateway.lock.test.${Date.now()}`);
  const result = spawnSync(process.execPath, ["scripts/test-projects.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_LOCK: isolatedLock,
    },
  });
  if (result.error) {
    console.error(`test runner failed to start: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

export function main(argv: readonly string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const port = resolveGatewayPort(undefined, process.env);

  console.log(`🧹 test:force - clearing gateway on port ${port}`);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    console.log("no listeners to kill");
  }

  console.log("running pnpm test…");
  runTests();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
