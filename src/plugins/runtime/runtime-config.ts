// Runtime config helpers expose scoped OpenClaw config reads to plugin runtimes.
import { getRuntimeConfig } from "../../config/io.runtime.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeConfig(): PluginRuntime["config"] {
  return {
    current: getRuntimeConfig,
    mutateConfigFile: async (params) => {
      const { mutateConfigFile } = await import("../../config/mutate.js");
      return await mutateConfigFile(params);
    },
    replaceConfigFile: async (params) => {
      const { replaceConfigFile } = await import("../../config/mutate.js");
      return await replaceConfigFile(params);
    },
  };
}
