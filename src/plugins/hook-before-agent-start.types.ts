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
  appendContext?: string;
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
