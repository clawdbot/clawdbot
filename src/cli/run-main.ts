import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureClawdbotCliOnPath } from "../infra/path-env.js";
import {
  onUncaughtException,
  onUnhandledRejection,
} from "../infra/process-signals.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";

export async function runCli(argv: string[] = process.argv) {
  loadDotEnv({ quiet: true });
  normalizeEnv();
  ensureClawdbotCliOnPath();

  // Capture all console output into structured logs while keeping stdout/stderr behavior.
  enableConsoleCapture();

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  const { buildProgram } = await import("./program.js");
  const program = buildProgram();

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  onUnhandledRejection((reason: unknown, _promise: Promise<unknown>) => {
    console.error(
      "[clawdbot] Unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
    process.exit(1);
  });

  onUncaughtException((error: Error) => {
    console.error(
      "[clawdbot] Uncaught exception:",
      error.stack ?? error.message,
    );
    process.exit(1);
  });

  await program.parseAsync(argv);
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
