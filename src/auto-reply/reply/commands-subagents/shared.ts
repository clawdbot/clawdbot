import { resolveStoredSubagentCapabilities } from "../../../agents/subagent-capabilities.js";
import type { ResolvedSubagentController } from "../../../agents/subagent-control.js";
import { subagentRuns } from "../../../agents/subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../../agents/subagent-registry-state.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  stripToolMessages,
} from "../../../agents/tools/sessions-helpers.js";
import { callGateway } from "../../../gateway/call.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { looksLikeSessionId } from "../../../sessions/session-id.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";
import { resolveCommandSurfaceChannel, resolveChannelAccountId } from "../channel-context.js";
import { extractMessageText, type ChatMessage } from "../commands-subagents-text.js";
import type { CommandHandler, CommandHandlerResult } from "../commands-types.js";
import {
  formatRunLabel,
  resolveSubagentTargetFromRuns,
  type SubagentTargetResolution,
} from "../subagents-utils.js";

export { stripToolMessages };
export { resolveCommandSurfaceChannel, resolveChannelAccountId };
export type { ChatMessage } from "../commands-subagents-text.js";

export const COMMAND = "/subagents";
export const COMMAND_KILL = "/kill";
const COMMAND_FOCUS = "/focus";
const COMMAND_UNFOCUS = "/unfocus";
const COMMAND_AGENTS = "/agents";
const ACTIONS = new Set([
  "list",
  "kill",
  "log",
  "send",
  "steer",
  "info",
  "spawn",
  "focus",
  "unfocus",
  "agents",
  "help",
]);

export const RECENT_WINDOW_MINUTES = 30;

type SubagentsAction =
  | "list"
  | "kill"
  | "log"
  | "send"
  | "steer"
  | "info"
  | "spawn"
  | "focus"
  | "unfocus"
  | "agents"
  | "help";

type SubagentsCommandParams = Parameters<CommandHandler>[0];

export type SubagentsCommandContext = {
  params: SubagentsCommandParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};

export function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function stopWithUnknownTargetError(error?: string): CommandHandlerResult {
  return stopWithText(`⚠️ ${error ?? "Unknown subagent."}`);
}

function resolveSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    isActive: (entry) =>
      !entry.endedAt ||
      Math.max(
        0,
        countPendingDescendantRunsFromRuns(
          getSubagentRunsSnapshotForRead(subagentRuns),
          entry.childSessionKey,
        ),
      ) > 0,
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
}

export function resolveSubagentEntryForToken(
  runs: SubagentRunRecord[],
  token: string | undefined,
): { entry: SubagentRunRecord } | { reply: CommandHandlerResult } {
  const resolved = resolveSubagentTarget(runs, token);
  if (!resolved.entry) {
    return { reply: stopWithUnknownTargetError(resolved.error) };
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
    opts?.preferCommandTarget ?? params.ctx.CommandSource === "native";
  const raw = shouldPreferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

export function resolveCommandSubagentController(
  params: SubagentsCommandParams,
  requesterKey: string,
): ResolvedSubagentController {
  if (!isSubagentSessionKey(requesterKey)) {
    return {
      controllerSessionKey: requesterKey,
      callerSessionKey: requesterKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(requesterKey, {
    cfg: params.cfg,
  });
  return {
    controllerSessionKey: requesterKey,
    callerSessionKey: requesterKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

export function resolveHandledPrefix(normalized: string): string | null {
  return normalized.startsWith(COMMAND)
    ? COMMAND
    : normalized.startsWith(COMMAND_KILL)
      ? COMMAND_KILL
      : normalized.startsWith(COMMAND_FOCUS)
        ? COMMAND_FOCUS
        : normalized.startsWith(COMMAND_UNFOCUS)
          ? COMMAND_UNFOCUS
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
  if (params.handledPrefix === COMMAND_KILL) {
    return "kill";
  }
  if (params.handledPrefix === COMMAND_FOCUS) {
    return "focus";
  }
  if (params.handledPrefix === COMMAND_UNFOCUS) {
    return "unfocus";
  }
  if (params.handledPrefix === COMMAND_AGENTS) {
    return "agents";
  }
  return null;
}

type FocusTargetResolution = {
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId: string;
  label?: string;
};

export async function resolveFocusTargetSession(params: {
  runs: SubagentRunRecord[];
  token: string;
  requesterKey?: string;
}): Promise<FocusTargetResolution | null> {
  const subagentMatch = resolveSubagentTarget(params.runs, params.token);
  if (subagentMatch.entry) {
    const key = subagentMatch.entry.childSessionKey;
    const parsed = parseAgentSessionKey(key);
    return {
      targetKind: "subagent",
      targetSessionKey: key,
      agentId: parsed?.agentId ?? "main",
      label: formatRunLabel(subagentMatch.entry),
    };
  }

  const token = params.token.trim();
  if (!token) {
    return null;
  }

  const attempts: Array<Record<string, string>> = [];
  const requesterKey = normalizeOptionalString(params.requesterKey);
  const spawnedBy = requesterKey && isSubagentSessionKey(requesterKey) ? requesterKey : undefined;
  attempts.push({ key: token });
  if (looksLikeSessionId(token)) {
    attempts.push({ sessionId: token });
  }
  attempts.push({ label: token });

  for (const attempt of attempts) {
    try {
      const resolved = await callGateway({
        method: "sessions.resolve",
        params: spawnedBy ? { ...attempt, spawnedBy } : attempt,
      });
      const key = normalizeOptionalString(resolved?.key) ?? "";
      if (!key) {
        continue;
      }
      const parsed = parseAgentSessionKey(key);
      return {
        targetKind: key.includes(":subagent:") ? "subagent" : "acp",
        targetSessionKey: key,
        agentId: parsed?.agentId ?? "main",
        label: token,
      };
    } catch {
      // Try the next resolution strategy.
    }
  }
  return null;
}

export function buildSubagentsHelp() {
  return [
    "Subagents",
    "Usage:",
    "- /subagents list",
    "- /subagents kill <id|#|all>",
    "- /subagents log <id|#> [limit] [tools]",
    "- /subagents info <id|#>",
    "- /subagents send <id|#> <message>",
    "- /subagents steer <id|#> <message>",
    "- /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
    "- /focus <subagent-label|session-key|session-id|session-label>",
    "- /unfocus",
    "- /agents",
    "- /session idle <duration|off>",
    "- /session max-age <duration|off>",
    "- /kill <id|#|all>",
    "",
    "Ids: use the list index (#), runId/session prefix, label, or full session key.",
  ].join("\n");
}

export function formatLogLines(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    const extracted = extractMessageText(msg);
    if (!extracted) {
      continue;
    }
    const label = extracted.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${extracted.text}`);
  }
  return lines;
}
