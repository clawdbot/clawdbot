import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "tsdown";
import { managedHandoffRuntimeEntrypoint } from "../../src/infra/update-managed-service-handoff-runtime-assets.ts";

/** The installed CLI and invocation compiler seal the same typed lease owner. */
export function createManagedHandoffBuildConfig(): UserConfig {
  const entry = managedHandoffRuntimeEntrypoint;
  return {
    entry: {
      [entry.distWorkerPath.replace(/\.mjs$/u, "")]: fileURLToPath(
        new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl),
      ),
    },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node22",
    dts: false,
    envPrefix: [],
    define: { SEALED_RUNTIME_BUILD: "true" },
    deps: { alwaysBundle: (id) => !isBuiltin(id), onlyBundle: false },
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: false },
    shims: true,
    sourcemap: false,
  };
}
