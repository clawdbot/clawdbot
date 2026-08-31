// Implements subagent log retrieval and pagination.
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { stripToolMessages } from "../../../agents/tools/chat-history-text.js";
import { callGateway } from "../../../gateway/call.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type ChatMessage,
  type SubagentsCommandContext,
  formatLogLines,
  resolveSubagentEntryForToken,
} from "./shared.js";

export async function handleSubagentsLogAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return commandReply("📜 Usage: /subagents log <id|#> [limit]");
  }

  const includeTools = restTokens.some(
    (token) => normalizeLowercaseStringOrEmpty(token) === "tools",
  );
  const limitToken = restTokens
    .slice(1)
    .find((token) => parseStrictNonNegativeInteger(token) !== undefined);
  const parsedLimit = parseStrictNonNegativeInteger(limitToken);
  const limit = parsedLimit === undefined ? 20 : Math.min(200, Math.max(1, parsedLimit));

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    params: { sessionKey: targetResolution.entry.childSessionKey, limit },
  });
  const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
  const filtered = includeTools ? rawMessages : stripToolMessages(rawMessages);
  const lines = formatLogLines(filtered as ChatMessage[]);
  const header = `📜 Subagent log: ${formatRunLabel(targetResolution.entry)}`;
  if (lines.length === 0) {
    return commandReply(`${header}\n(no messages)`);
  }
  return commandReply([header, ...lines].join("\n"));
}
