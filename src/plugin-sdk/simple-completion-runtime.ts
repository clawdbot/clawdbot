// Compat surface: openclaw/plugin-sdk/simple-completion-runtime
// Provides stable simple LLM completion helpers for channel extensions.

import type { OpenClawConfig } from "../config/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimpleCompletionModelSelection = {
  provider: string;
  modelId: string;
};

export type SimpleCompletionModelPreparationError = {
  error: string;
  selection?: SimpleCompletionModelSelection;
};

export type PreparedSimpleCompletionModel = {
  model: {
    provider: string;
    modelId: string;
    apiBase?: string;
    [key: string]: unknown;
  };
  auth: {
    apiKey?: string;
    [key: string]: unknown;
  };
};

export type SimpleCompletionModelPreparationResult =
  | SimpleCompletionModelPreparationError
  | PreparedSimpleCompletionModel;

export type SimpleCompletionMessage = {
  role: "user" | "assistant" | "system";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Prepares an LLM model reference for use with completeWithPreparedSimpleCompletionModel.
 * Returns an error descriptor if no suitable model can be resolved.
 */
export async function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  allowMissingApiKeyModes?: string[];
}): Promise<SimpleCompletionModelPreparationResult> {
  void params;
  return { error: "simple-completion-runtime: not implemented in this build", selection: undefined };
}

/**
 * Runs a simple single-turn LLM completion using the prepared model/auth.
 */
export async function completeWithPreparedSimpleCompletionModel(params: {
  model: PreparedSimpleCompletionModel["model"];
  auth: PreparedSimpleCompletionModel["auth"];
  messages: SimpleCompletionMessage[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<SimpleCompletionMessage | null> {
  void params;
  return null;
}

/**
 * Extracts the text content from an assistant message.
 */
export function extractAssistantText(
  message: SimpleCompletionMessage | null | undefined,
): string {
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
  }
  return "";
}
