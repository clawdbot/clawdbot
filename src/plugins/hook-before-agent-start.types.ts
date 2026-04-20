// before_model_resolve hook
export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
};

// before_prompt_build hook
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};

export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS = [
  "systemPrompt",
  "prependContext",
  "prependSystemContext",
  "appendSystemContext",
] as const satisfies readonly (keyof PluginHookBeforePromptBuildResult)[];

type MissingPluginPromptMutationResultFields = Exclude<
  keyof PluginHookBeforePromptBuildResult,
  (typeof PLUGIN_PROMPT_MUTATION_RESULT_FIELDS)[number]
>;
type AssertAllPluginPromptMutationResultFieldsListed =
  MissingPluginPromptMutationResultFields extends never ? true : never;
const assertAllPluginPromptMutationResultFieldsListed: AssertAllPluginPromptMutationResultFieldsListed = true;
void assertAllPluginPromptMutationResultFieldsListed;

// before_agent_start hook (legacy compatibility: combines both phases)
export type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  /** Optional because legacy hook can run in pre-session phase. */
  messages?: unknown[];
};

export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &
  PluginHookBeforeModelResolveResult;

export type PluginHookBeforeAgentStartOverrideResult = Omit<
  PluginHookBeforeAgentStartResult,
  keyof PluginHookBeforePromptBuildResult
>;

export const stripPromptMutationFieldsFromLegacyHookResult = (
  result: PluginHookBeforeAgentStartResult | void,
): PluginHookBeforeAgentStartOverrideResult | void => {
  if (!result || typeof result !== "object") {
    return result;
  }
  const remaining: Partial<PluginHookBeforeAgentStartResult> = { ...result };
  for (const field of PLUGIN_PROMPT_MUTATION_RESULT_FIELDS) {
    delete remaining[field];
  }
  return Object.keys(remaining).length > 0
    ? (remaining as PluginHookBeforeAgentStartOverrideResult)
    : undefined;
};
