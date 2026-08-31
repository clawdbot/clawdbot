import { fileURLToPath } from "node:url";
import { tuiPtyRuntimeEntrypoints } from "../../src/tui/tui-pty-runtime-test-support.ts";
import { runtimeProcessBuildEntries } from "./runtime-process-build-entries.mts";

// Test-only roots share the invocation generation without changing package entries.
export const vitestWorkerBuildEntries = {
  ...runtimeProcessBuildEntries,
  ...Object.fromEntries(
    Object.values(tuiPtyRuntimeEntrypoints).map((entry) => [
      entry.distWorkerPath.replace(/\.js$/u, ""),
      fileURLToPath(new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl)),
    ]),
  ),
  // The real ulimit fixture must import its parent before imposing a file-size limit.
  "infra/sqlite-readonly-location": "src/infra/sqlite-readonly-location.ts",
  // Exercise native writes through the existing plugin facade in the private graph.
  "plugin-sdk/file-access-runtime": "src/plugin-sdk/file-access-runtime.ts",
};
