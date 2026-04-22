#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatUncaughtError } from "./infra/errors.js";
import { isMainModule } from "./infra/is-main.js";
import { installUnhandledRejectionHandler } from "./infra/unhandled-rejections.js";

type LegacyCliDeps = {
  runCli: (argv: string[]) => Promise<void>;
};

type LibraryExports = typeof import("./library.js");

// These bindings are populated only for library consumers. The CLI entry stays
// on the lean path and must not read them while running as main.
export let applyTemplate: LibraryExports["applyTemplate"];
export let createDefaultDeps: LibraryExports["createDefaultDeps"];
export let deriveSessionKey: LibraryExports["deriveSessionKey"];
export let describePortOwner: LibraryExports["describePortOwner"];
export let ensureBinary: LibraryExports["ensureBinary"];
export let ensurePortAvailable: LibraryExports["ensurePortAvailable"];
export let getReplyFromConfig: LibraryExports["getReplyFromConfig"];
export let handlePortError: LibraryExports["handlePortError"];
export let loadConfig: LibraryExports["loadConfig"];
export let loadSessionStore: LibraryExports["loadSessionStore"];
export let monitorWebChannel: LibraryExports["monitorWebChannel"];
export let normalizeE164: LibraryExports["normalizeE164"];
export let PortInUseError: LibraryExports["PortInUseError"];
export let promptYesNo: LibraryExports["promptYesNo"];
export let resolveSessionKey: LibraryExports["resolveSessionKey"];
export let resolveStorePath: LibraryExports["resolveStorePath"];
export let runCommandWithTimeout: LibraryExports["runCommandWithTimeout"];
export let runExec: LibraryExports["runExec"];
export let saveSessionStore: LibraryExports["saveSessionStore"];
export let waitForever: LibraryExports["waitForever"];

async function loadLegacyCliDeps(): Promise<LegacyCliDeps> {
  const { runCli } = await import("./cli/run-main.js");
  return { runCli };
}

// Legacy direct file entrypoint only. Package root exports now live in library.ts.
export async function runLegacyCliEntry(
  argv: string[] = process.argv,
  deps?: LegacyCliDeps,
): Promise<void> {
  const { runCli } = deps ?? (await loadLegacyCliDeps());
  await runCli(argv);
}

const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

if (!isMain) {
  ({
    applyTemplate,
    createDefaultDeps,
    deriveSessionKey,
    describePortOwner,
    ensureBinary,
    ensurePortAvailable,
    getReplyFromConfig,
    handlePortError,
    loadConfig,
    loadSessionStore,
    monitorWebChannel,
    normalizeE164,
    PortInUseError,
    promptYesNo,
    resolveSessionKey,
    resolveStorePath,
    runCommandWithTimeout,
    runExec,
    saveSessionStore,
    waitForever,
  } = await import("./library.js"));
}

if (isMain) {
  const { restoreTerminalState } = await import("./terminal/restore.js");

  // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
  // These log the error and exit gracefully instead of crashing without trace.
  installUnhandledRejectionHandler();

  process.on("uncaughtException", (error) => {
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
    process.exit(1);
  });

  void runLegacyCliEntry(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    restoreTerminalState("legacy cli failure", { resumeStdinIfPaused: false });
    process.exit(1);
  });
}
