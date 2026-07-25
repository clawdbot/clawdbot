// Gateway CLI session history importer.
// Augments local chat history with bound external Claude CLI transcripts.
import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const ANTHROPIC_PROVIDER = "anthropic";

export { readClaudeCliFallbackSeed, resolveClaudeCliBindingSessionId };
export type { ClaudeCliFallbackSeed };

type CliSessionHistoryAugmentation = {
  messages: unknown[];
  imported: boolean;
};

/** Resolves chat history plus whether a bound external transcript was actually incorporated. */
export function resolveChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): CliSessionHistoryAugmentation {
  const cliSessionBinding = getCliSessionBinding(params.entry, CLAUDE_CLI_PROVIDER);
  const cliSessionId = cliSessionBinding?.sessionId;
  if (!cliSessionId) {
    return { messages: params.localMessages, imported: false };
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    normalizedProvider !== ANTHROPIC_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return { messages: params.localMessages, imported: false };
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
    localSessionId: params.entry?.sessionId,
    reseedReceipt: cliSessionBinding.reseedReceipt,
  });
  if (importedMessages.length === 0) {
    return { messages: params.localMessages, imported: false };
  }
  const messages = mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
  return messages.length > params.localMessages.length
    ? { messages, imported: true }
    : { messages: params.localMessages, imported: false };
}

/** Augments local chat history with bound Claude CLI session messages when applicable. */
export function augmentChatHistoryWithCliSessionImports(
  params: Parameters<typeof resolveChatHistoryWithCliSessionImports>[0],
): unknown[] {
  return resolveChatHistoryWithCliSessionImports(params).messages;
}
