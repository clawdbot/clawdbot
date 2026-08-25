// Gateway CLI session history importer.
// Augments local chat history with bound external Claude CLI transcripts.
import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import { readClaudeCliSessionMessagesAsync } from "./cli-session-history.claude-snapshot.js";
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

type CliSessionHistoryParams = {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
  preparedImportedMessages?: unknown[];
};

function resolveEligibleCliSessionBinding(params: CliSessionHistoryParams) {
  const binding = getCliSessionBinding(params.entry, CLAUDE_CLI_PROVIDER);
  const provider = normalizeProviderId(params.provider ?? "");
  const eligible =
    !provider ||
    params.localMessages.length === 0 ||
    provider === CLAUDE_CLI_PROVIDER ||
    provider === ANTHROPIC_PROVIDER;
  return binding?.sessionId && eligible ? binding : undefined;
}

/** Resolves chat history plus whether a bound external transcript was actually incorporated. */
export function resolveChatHistoryWithCliSessionImports(params: CliSessionHistoryParams): {
  messages: unknown[];
  imported: boolean;
} {
  const binding = resolveEligibleCliSessionBinding(params);
  if (!binding) {
    return { messages: params.localMessages, imported: false };
  }
  const importedMessages =
    params.preparedImportedMessages ??
    readClaudeCliSessionMessages({
      cliSessionId: binding.sessionId,
      homeDir: params.homeDir,
      localSessionId: params.entry?.sessionId,
      reseedReceipt: binding.reseedReceipt,
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

/** Acquires one request-local redacted view of the process-owned external snapshot. */
export async function readChatHistoryCliSessionImportSnapshot(
  params: CliSessionHistoryParams,
): Promise<unknown[]> {
  const binding = resolveEligibleCliSessionBinding(params);
  return binding?.sessionId
    ? await readClaudeCliSessionMessagesAsync({
        cliSessionId: binding.sessionId,
        homeDir: params.homeDir,
        localSessionId: params.entry?.sessionId,
        reseedReceipt: binding.reseedReceipt,
      })
    : [];
}
