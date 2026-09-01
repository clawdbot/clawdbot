import { fileURLToPath } from "node:url";
import { vectorKnnProcessEntrypoint } from "../../extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.ts";

export const runtimeProcessBuildEntries = Object.fromEntries(
  [...Object.values(runtimeProcessEntrypoints), vectorKnnProcessEntrypoint].map((entry) => [
    entry.distWorkerPath.replace(/\.js$/u, ""),
    fileURLToPath(new URL(`./${entry.sourceWorkerName}.ts`, entry.currentModuleUrl)),
  ]),
);
