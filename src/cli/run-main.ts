import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../infra/dotenv.js";
import { normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureClawdbotCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) return argv;

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

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
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error(
      "[clawdbot] Uncaught exception:",
      error.stack ?? error.message,
    );
    process.exit(1);
  });

  await program.parseAsync(rewriteUpdateFlagArgv(argv));
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
