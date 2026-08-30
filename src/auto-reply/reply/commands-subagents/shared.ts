// Shared helpers for subagent command actions and target resolution.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { buildSubagentRunReadIndex } from "../../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../../agents/subagents/registry/subagent-registry.types.js";
import { buildSubagentRunView } from "../../../agents/subagents/registry/subagent-run-view.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../../agents/tools/sessions-helpers.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../../command-turn-context.js";
import { commandReply } from "../command-gates.js";
import { extractSubagentMessageText, type ChatMessage } from "../commands-subagents-text.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";

export type { ChatMessage } from "../commands-subagents-text.js";

export const RECENT_WINDOW_MINUTES = 30;

type SubagentsCommandParams = Parameters<CommandHandler>[0];

export type SubagentsCommandContext = {
  params: SubagentsCommandParams;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};

export function resolveSubagentEntryForToken(
  runs: SubagentRunRecord[],
  token: string | undefined,
): { entry: SubagentRunRecord } | { reply: CommandHandlerResult } {
  const fail = (message: string) => ({ reply: commandReply(`⚠️ ${message}`) });
  const trimmed = normalizeOptionalString(token);
  if (!trimmed) {
    return fail("Missing subagent id.");
  }
  const readIndex = buildSubagentRunReadIndex();
  const { latest, active, recent } = buildSubagentRunView({
    runs,
    recentMinutes: RECENT_WINDOW_MINUTES,
    countPendingDescendantRuns: (sessionKey) => readIndex.countPendingDescendantRuns(sessionKey),
  });
  if (trimmed === "last") {
    const entry = latest[0];
    return entry ? { entry } : fail("Unknown subagent.");
  }
  const numericOrder = [...active, ...recent];
  if (/^\d+$/.test(trimmed)) {
    const entry = numericOrder[Number.parseInt(trimmed, 10) - 1];
    return entry ? { entry } : fail(`Invalid subagent index: ${trimmed}`);
  }
  if (trimmed.includes(":")) {
    const entry = latest.find((run) => run.childSessionKey === trimmed);
    return entry ? { entry } : fail(`Unknown subagent session: ${trimmed}`);
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const match = (entries: SubagentRunRecord[], ambiguity: string) => {
    if (entries.length > 1) {
      return fail(`${ambiguity}: ${trimmed}`);
    }
    const entry = entries[0];
    return entry ? { entry } : undefined;
  };
  return (
    match(
      numericOrder.filter((entry) => normalizeLowercaseStringOrEmpty(entry.taskName) === lowered),
      "Ambiguous subagent label",
    ) ??
    match(
      latest.filter((entry) => normalizeLowercaseStringOrEmpty(formatRunLabel(entry)) === lowered),
      "Ambiguous subagent label",
    ) ??
    match(
      numericOrder.filter((entry) =>
        normalizeLowercaseStringOrEmpty(entry.taskName).startsWith(lowered),
      ),
      "Ambiguous subagent label prefix",
    ) ??
    match(
      latest.filter((entry) =>
        normalizeLowercaseStringOrEmpty(formatRunLabel(entry)).startsWith(lowered),
      ),
      "Ambiguous subagent label prefix",
    ) ??
    match(
      latest.filter((entry) => entry.runId.startsWith(trimmed)),
      "Ambiguous run id prefix",
    ) ??
    fail(`Unknown subagent id: ${trimmed}`)
  );
}

export function resolveRequesterSessionKey(
  params: SubagentsCommandParams,
  opts?: { preferCommandTarget?: boolean },
): string | undefined {
  const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
  const commandSession = normalizeOptionalString(params.sessionKey);
  const shouldPreferCommandTarget =
    opts?.preferCommandTarget ?? isNativeCommandTurn(resolveCommandTurnContext(params.ctx));
  const raw = shouldPreferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

export function buildSubagentsHelp() {
  return [
    "Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /session unbind",
    "- /agents",
    "- /session idle <duration|off>",
    "- /session max-age <duration|off>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}

export function formatLogLines(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    const extracted = extractSubagentMessageText(msg);
    if (!extracted) {
      continue;
    }
    const label = extracted.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${extracted.text}`);
  }
  return lines;
}
