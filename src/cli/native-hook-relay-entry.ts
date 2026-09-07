#!/usr/bin/env node
// Dedicated cold-process entrypoint for native provider hook relays.
import process from "node:process";
import { runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";
import { drainOneShotOutput } from "./one-shot-output.js";

process.title = "openclaw-hooks";
let exitCode = 1;
try {
  exitCode = await runNativeHookRelayCliFromArgv(process.argv);
} catch (error) {
  process.stderr.write(
    `native hook relay failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
drainOneShotOutput(() => process.exit(exitCode));
