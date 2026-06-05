// Gateway CLI session history importer.
// Augments local chat history with bound external Claude CLI transcripts.
import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const ANTHROPIC_PROVIDER = "anthropic";

export {
  mergeImportedChatHistoryMessages,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
};
export type { ClaudeCliFallbackSeed };

/** Augments local chat history with bound Claude CLI session messages when applicable. */
export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  const cliSessionId = resolveClaudeCliBindingSessionId(params.entry);
  if (!cliSessionId) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    normalizedProvider !== ANTHROPIC_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
  });
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
