/**
 * Creates the resource loader used by embedded-agent sessions.
 */
import { DefaultResourceLoader } from "../sessions/index.js";

/**
 * Resource-loader setup for embedded-agent sessions.
 *
 * Embedded runs receive explicit tools/resources from the runner, so discovery disables ambient
 * extensions, skills, prompt templates, themes, and context files.
 */
type DefaultResourceLoaderInit = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Discovery options that keep embedded sessions isolated from ambient local resources. */
export const EMBEDDED_AGENT_RESOURCE_LOADER_DISCOVERY_OPTIONS = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} satisfies Partial<DefaultResourceLoaderInit>;

/** Creates the constrained resource loader used by embedded-agent session construction. */
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
