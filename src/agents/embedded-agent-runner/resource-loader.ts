import { DefaultResourceLoader } from "../sessions/resource-loader.js";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Embedded sessions consume prepared resources, never ambient local discovery. */
export function createEmbeddedAgentResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    | "cwd"
    | "agentDir"
    | "settingsManager"
    | "extensionFactories"
    | "agentsFilesOverride"
    | "appendSystemPromptTransform"
  >,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // Explicit empty sources bypass SYSTEM.md/APPEND_SYSTEM.md discovery before any reads.
    // Runtime-owned prompt text and bounded context are supplied by the caller.
    systemPrompt: "",
    appendSystemPrompt: [],
  });
}
