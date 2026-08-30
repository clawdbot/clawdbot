// Shared helpers for subagent command actions and target resolution.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { buildSubagentRunReadIndex } from "../../../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../../../agents/subagents/registry/subagent-registry.types.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../../agents/tools/sessions-helpers.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../../command-turn-context.js";
import { commandReply } from "../command-gates.js";
import { extractSubagentMessageText, type ChatMessage } from "../commands-subagents-text.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel, resolveSubagentTargetFromRuns } from "../subagents-utils.js";

export type { ChatMessage } from "../commands-subagents-text.js";

const COMMAND = "/subagents";
const COMMAND_AGENTS = "/agents";
const ACTIONS = new Set(["list", "log", "info", "help"]);

export const RECENT_WINDOW_MINUTES = 30;

type SubagentsAction = "list" | "log" | "info" | "agents" | "help";

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
  const readIndex = buildSubagentRunReadIndex();
  const resolved = resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    aliases: (entry) => (entry.taskName ? [entry.taskName] : []),
    isActive: (entry) =>
      !entry.execution.endedAt ||
      Math.max(0, readIndex.countPendingDescendantRuns(entry.childSessionKey)) > 0,
    errors: {
      missingTarget: "Missing subagent id.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent id: ${value}`,
    },
  });
  if (!resolved.entry) {
    return { reply: commandReply(`⚠️ ${resolved.error ?? "Unknown subagent."}`) };
  }
  return { entry: resolved.entry };
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

export function resolveHandledPrefix(normalized: string): string | null {
  return normalized.startsWith(COMMAND)
    ? COMMAND
    : normalized.startsWith(COMMAND_AGENTS)
      ? COMMAND_AGENTS
      : null;
}

export function resolveSubagentsAction(params: {
  handledPrefix: string;
  restTokens: string[];
}): SubagentsAction | null {
  if (params.handledPrefix === COMMAND) {
    const [actionRaw] = params.restTokens;
    const action = (normalizeLowercaseStringOrEmpty(actionRaw) || "list") as SubagentsAction;
    if (!ACTIONS.has(action)) {
      return null;
    }
    params.restTokens.splice(0, 1);
    return action;
  }
  if (params.handledPrefix === COMMAND_AGENTS) {
    return "agents";
  }
  return null;
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
