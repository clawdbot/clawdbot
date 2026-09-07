/**
 * Shared user-facing auth guidance for session/model selection failures.
 *
 * Uses docs paths instead of provider-specific instructions so guidance stays correct across OAuth/API-key providers.
 */
import { join } from "node:path";
import { getDocsPath } from "../config.js";

const UNKNOWN_PROVIDER = "unknown";

/** Returns the standard provider login help block. */
function getProviderLoginHelp(): string {
  return [
    "Use /login to log into a provider via OAuth or API key. See:",
    `  ${join(getDocsPath(), "providers.md")}`,
    `  ${join(getDocsPath(), "models.md")}`,
  ].join("\n");
}

/** Formats the message shown when no configured model can be used. */
export function formatNoModelsAvailableMessage(): string {
  return `No models available. ${getProviderLoginHelp()}`;
}

/** Formats the message shown before a model is selected. */
export function formatNoModelSelectedMessage(): string {
  return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

/** Formats the missing API key guidance for a provider or unknown selected model. */
export function formatNoApiKeyFoundMessage(provider: string): string {
  const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
  return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
