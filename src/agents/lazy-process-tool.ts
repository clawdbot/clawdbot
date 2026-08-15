import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeProcessTool } from "./bash-tools.descriptions.js";
import type { ProcessToolDefaults } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";

type BashToolsModule = typeof import("./bash-tools.js");

const bashToolsModuleLoader = createLazyImportLoader<BashToolsModule>(
  () => import("./bash-tools.js"),
);

/** Build process lazily so tool discovery does not load the shell runtime. */
export function createLazyProcessTool(defaults?: ProcessToolDefaults): AnyAgentTool {
  let loadedTool: AnyAgentTool | undefined;
  const loadTool = async () => {
    if (!loadedTool) {
      const { createProcessTool } = await bashToolsModuleLoader.load();
      loadedTool = createProcessTool(defaults) as unknown as AnyAgentTool;
    }
    return loadedTool;
  };

  return {
    name: "process",
    label: "process",
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    parameters: processSchema,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      (await loadTool()).execute(...args),
  } as AnyAgentTool;
}
