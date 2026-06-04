// Lists available agents for subagent spawn and focus commands.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { subagentRuns } from "../../../agents/subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../../agents/subagent-registry-state.js";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel, sortSubagentRuns } from "../subagents-utils.js";
import {
  RECENT_WINDOW_MINUTES,
  type SubagentsCommandContext,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  stopWithText,
} from "./shared.js";

function formatConversationBindingText(params: { conversationId: string }): string {
  return `binding:${params.conversationId}`;
}

function supportsConversationBindings(channel: string): boolean {
  const channelId = normalizeChannelId(channel);
  if (!channelId) {
    return false;
  }
  return (
    getChannelPlugin(channelId)?.conversationBindings?.supportsCurrentConversationBinding === true
  );
}

export function handleSubagentsAgentsAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, requesterKey, runs } = ctx;
  const runsSnapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const channel = resolveCommandSurfaceChannel(params);
  const accountId = resolveChannelAccountId(params);
  const currentConversationBindingsSupported = supportsConversationBindings(channel);
  const bindingService = getSessionBindingService();
  const bindingsBySession = new Map<string, ReturnType<typeof bindingService.listBySession>>();

  const resolveSessionBindings = (sessionKey: string) => {
    const cached = bindingsBySession.get(sessionKey);
    if (cached) {
      return cached;
    }
    const resolved = bindingService
      .listBySession(sessionKey)
      .filter(
        (entry) =>
          entry.status === "active" &&
          entry.conversation.channel === channel &&
          entry.conversation.accountId === accountId,
      );
    bindingsBySession.set(sessionKey, resolved);
    return resolved;
  };

  const dedupedRuns: typeof runs = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sortSubagentRuns(runs)) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    dedupedRuns.push(entry);
  }

  const recentCutoff = Date.now() - RECENT_WINDOW_MINUTES * 60_000;
  const numericOrder = [
    ...dedupedRuns.filter(
      (entry) =>
        !entry.endedAt ||
        countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) > 0,
    ),
    ...dedupedRuns.filter(
      (entry) =>
        entry.endedAt &&
        countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) === 0 &&
        entry.endedAt >= recentCutoff,
    ),
  ];
  const indexByChildSessionKey = new Map(
    numericOrder.map((entry, idx) => [entry.childSessionKey, idx + 1] as const),
  );

  const visibleRuns: typeof dedupedRuns = [];
  for (const entry of dedupedRuns) {
    const visible =
      !entry.endedAt ||
      countPendingDescendantRunsFromRuns(runsSnapshot, entry.childSessionKey) > 0 ||
      resolveSessionBindings(entry.childSessionKey).length > 0;
    if (!visible) {
      continue;
    }
    visibleRuns.push(entry);
  }

  const lines = ["agents:", "-----"];
  if (visibleRuns.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of visibleRuns) {
      const binding = resolveSessionBindings(entry.childSessionKey)[0];
      const bindingText = binding
        ? formatConversationBindingText({
            conversationId: binding.conversation.conversationId,
          })
        : currentConversationBindingsSupported
          ? "unbound"
          : "bindings unavailable";
      const resolvedIndex = indexByChildSessionKey.get(entry.childSessionKey);
      const prefix = resolvedIndex ? `${resolvedIndex}.` : "-";
      lines.push(`${prefix} ${formatRunLabel(entry)} (${bindingText})`);
    }
  }

  const requesterBindings = resolveSessionBindings(requesterKey).filter(
    (entry) => entry.targetKind === "session",
  );
  if (requesterBindings.length > 0) {
    lines.push("", "acp/session bindings:", "-----");
    for (const binding of requesterBindings) {
      const label = normalizeOptionalString(binding.metadata?.label) ?? binding.targetSessionKey;
      lines.push(
        `- ${label} (${formatConversationBindingText({
          conversationId: binding.conversation.conversationId,
        })}, session:${binding.targetSessionKey})`,
      );
    }
  }

  return stopWithText(lines.join("\n"));
}
