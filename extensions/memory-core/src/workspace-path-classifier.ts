// Memory Core classifies automatic workspace context without loading the search manager.
import path from "node:path";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryPathClassification } from "./memory/memory-path-provenance.js";

type ClassifyWorkspaceMemoryPaths = NonNullable<
  MemoryPluginRuntime["classifyWorkspaceMemoryPaths"]
>;

export const classifyWorkspaceMemoryPaths: ClassifyWorkspaceMemoryPaths = async (params) =>
  await Promise.all(
    params.relativePaths.map(async (relativePath) => {
      const classification = await resolveMemoryPathClassification({
        absolutePath: path.resolve(params.workspaceDir, relativePath),
        source: "memory",
        workspaceDir: params.workspaceDir,
      });
      return { relativePath, originClass: classification.originClass };
    }),
  );
