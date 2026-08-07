#!/usr/bin/env node
// Dedicated cold-process entrypoint for native provider hook relays.
import process from "node:process";
import { runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";

function formatNativeHookRelayEntryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function flushNativeHookRelayOutput(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.write("", () => resolve());
        }),
    ),
  );
}

process.title = "openclaw-hooks";
let exitCode = 1;
try {
  exitCode = await runNativeHookRelayCliFromArgv(process.argv);
} catch (error) {
  process.stderr.write(`native hook relay failed: ${formatNativeHookRelayEntryError(error)}\n`);
}
await flushNativeHookRelayOutput();
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
process.exit(exitCode);
