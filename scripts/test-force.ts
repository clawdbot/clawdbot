#!/usr/bin/env bun
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { forceFreePort, type PortProcess } from "../src/cli/ports.js";

const DEFAULT_PORT = 18789;

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
    process.env.CLAWDBOT_GATEWAY_LOCK ??
    path.join(os.tmpdir(), `clawdbot-gateway.lock.test.${Date.now()}`);
  const result = spawnSync("pnpm", ["vitest", "run"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAWDBOT_GATEWAY_LOCK: isolatedLock,
    },
  });
  if (result.error) {
    console.error(`pnpm test failed to start: ${String(result.error)}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function main() {
  const port = Number.parseInt(
    process.env.CLAWDBOT_GATEWAY_PORT ?? `${DEFAULT_PORT}`,
    10,
  );

  console.log(`🧹 test:force - clearing gateway on port ${port}`);
  const killed = killGatewayListeners(port);
  if (killed.length === 0) {
    console.log("no listeners to kill");
  }

  console.log("running pnpm test…");
  runTests();
}

main();
