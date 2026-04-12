#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { forceFreePort, type PortProcess } from "../src/cli/ports.js";
import { resolveGatewayPort } from "../src/config/config.js";

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

function main() {
  const port = resolveGatewayPort(undefined, process.env);

  console.log(`🧹 test:force - clearing gateway on port ${port}`);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    console.log("no listeners to kill");
  }

  console.log("running pnpm test…");
  runTests();
}

main();
