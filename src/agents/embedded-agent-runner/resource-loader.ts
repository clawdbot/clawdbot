import { DefaultResourceLoader } from "../sessions/index.js";

type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

export const EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

export function createEmbeddedAgentResourceLoader(
  options: Pick<
    DefaultResourceLoaderInit,
    "cwd" | "agentDir" | "settingsManager" | "extensionFactories"
  >,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    ...EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  });
}
