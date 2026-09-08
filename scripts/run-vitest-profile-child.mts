import { getHashes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ViteUserConfig } from "vitest/config";
import { isVitestProfileError, startVitestProfile } from "./lib/vitest-profiler.mts";

const [mode, outputDir, ...args] = process.argv.slice(2);
if ((mode !== "main" && mode !== "runner") || !outputDir) {
  throw new Error("Expected profiler mode and output directory.");
}
// Start before importing Vitest so main capture includes Vite/Vitest startup.
const finishMain = mode === "main" ? await startVitestProfile(outputDir, false) : undefined;
try {
  // Node 24's background CA loader can deadlock with Undici's first hash enumeration.
  // Populate that cached result before TLS loads, inside main's startup capture.
  // Remove when supported Node/OpenSSL versions make concurrent initialization safe.
  getHashes();
  const { parseCLI, startVitest } = await import("vitest/node");
  const { normalizePath } = await import("vite");
  const { filter, options } = parseCLI(["vitest", ...args]);
  // Match native help truthiness (including repeated-flag arrays); parseCLI's type omits help.
  if ("help" in options && options.help) {
    await finishMain?.();
    process.exit(0);
  }
  const cliOptions = {
    config: "test/vitest/vitest.unit.config.ts",
    fileParallelism: false,
    ...options,
  };
  // parseCLI parses flags; Vitest's CLI applies these run-mode normalizations
  // separately. Keep additive excludes and file:line/typecheck selection intact.
  if (cliOptions.exclude) {
    cliOptions.cliExclude = cliOptions.exclude;
    delete cliOptions.exclude;
  }
  if (filter.some((file) => file.includes(":"))) {
    cliOptions.includeTaskLocation ??= true;
  }
  if (typeof cliOptions.typecheck?.only === "boolean") {
    cliOptions.typecheck.enabled ??= true;
  }
  if (cliOptions.clearCache || cliOptions.listTags) {
    cliOptions.watch = false;
    cliOptions.run = true;
  }
  const profilingConfig: ViteUserConfig = {};
  if (mode === "runner") {
    const setup = fileURLToPath(new URL("./lib/vitest-profiler.mts", import.meta.url));
    // Vite appends this array to the configured setup, including scalar setup paths.
    profilingConfig.test = {
      globalSetup: [setup],
      provide: { openclawVitestProfileDir: outputDir },
    };
  }
  const normalizedFilters = filter.map((file) => normalizePath(file.replaceAll("\\", "/")));
  const vitest = await startVitest("test", normalizedFilters, cliOptions, profilingConfig);
  if (!vitest.shouldKeepServer()) {
    try {
      await finishMain?.();
    } finally {
      await vitest.exit();
    }
    // Worker teardown can report errors after Vitest has finalized the test result.
    const profileErrors = vitest.state.getUnhandledErrors().filter(isVitestProfileError);
    if (profileErrors.length) {
      vitest.logger.printUnhandledErrors(profileErrors);
      process.exitCode ||= 1;
    }
  }
} catch (error) {
  try {
    await finishMain?.();
  } catch (cleanupError) {
    // Keep the startup error as the thrown failure while reporting a distinct
    // finalization failure; reawaiting one failed finalizer must not report it twice.
    if (cleanupError !== error) {
      console.error(cleanupError);
    }
  }
  throw error;
}
