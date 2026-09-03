import { vectorKnnProcessEntrypoint } from "../../extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts";
import {
  createRuntimeProcessBuildEntries,
  runtimeProcessCoreBuildEntries,
} from "./runtime-process-core-build-entries.mts";

export const runtimeProcessBuildEntries = {
  ...runtimeProcessCoreBuildEntries,
  ...createRuntimeProcessBuildEntries([vectorKnnProcessEntrypoint]),
};
