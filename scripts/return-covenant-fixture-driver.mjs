#!/usr/bin/env node

import { fileURLToPath } from "node:url";

try {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const { runReturnCovenantFixtureDriver, runReturnCovenantFixtureGateway } =
    await import("../dist/test-runtime/return-covenant-fixture-driver.js");
  if (process.argv.length === 3 && process.argv[2] === "gateway") {
    await runReturnCovenantFixtureGateway();
  } else {
    await runReturnCovenantFixtureDriver(process.argv.slice(2));
  }
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write("[return-covenant-fixture-driver] FAILED (exit 1)\n");
  process.exitCode = 1;
}
