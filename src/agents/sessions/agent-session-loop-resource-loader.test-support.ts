import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createSyntheticSourceInfo } from "./source-info.js";

export function createResourceLoader(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>> = new Map(),
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", {
                source: "temporary",
              }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function createCompactionHandlers() {
  return new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
    [
      "session_before_compact",
      [
        async (event: unknown) => {
          const preparation = (
            event as {
              preparation: { firstKeptEntryId: string; tokensBefore: number };
            }
          ).preparation;
          return {
            compaction: {
              summary: "condensed history",
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
            },
          };
        },
      ],
    ],
  ]);
}
