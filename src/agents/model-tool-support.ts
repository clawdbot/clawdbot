/**
 * Model capability helper for tool-use support.
 *
 * Provider catalogs can opt a model out via `compat.supportsTools === false`;
 * absent metadata remains permissive for older catalog entries.
 */
const MODEL_TOOLS_UNAVAILABLE_PROMPT =
  "## Tool availability\n\nThis model cannot use tools in this run. Do not claim that you ran commands, read or wrote files, browsed the web, generated media, or performed any other tool-backed action. If a request requires tools, say they are unavailable in this chat and ask the user to switch to a tool-capable model.";

/** Returns whether a catalog model should be offered tool calls. */
export function supportsModelTools(model: { compat?: unknown }): boolean {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as { supportsTools?: boolean })
      : undefined;
  return compat?.supportsTools !== false;
}

/** Builds the bounded honesty guard for models that explicitly disable tools. */
export function buildModelToolsUnavailablePrompt(modelToolsEnabled: boolean): string | undefined {
  return modelToolsEnabled ? undefined : MODEL_TOOLS_UNAVAILABLE_PROMPT;
}
