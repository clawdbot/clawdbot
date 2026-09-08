// Lists available agents and conversation bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildSubagentRunReadIndex } from "../../../agents/subagents/registry/subagent-registry-read.js";
import { buildSubagentRunView } from "../../../agents/subagents/registry/subagent-run-view.js";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "../channel-context.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import { RECENT_WINDOW_MINUTES, type SubagentsCommandContext } from "./shared.js";

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
  const readIndex = buildSubagentRunReadIndex();
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

  const { latest, active, recent } = buildSubagentRunView({
    runs,
    recentMinutes: RECENT_WINDOW_MINUTES,
    countPendingDescendantRuns: (sessionKey) => readIndex.countPendingDescendantRuns(sessionKey),
  });
  const indexByChildSessionKey = new Map(
    [...active, ...recent].map((entry, idx) => [entry.childSessionKey, idx + 1] as const),
  );
  const activeRuns = new Set(active);
  const visibleRuns = latest.filter(
    (entry) => activeRuns.has(entry) || resolveSessionBindings(entry.childSessionKey).length > 0,
  );

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

  return commandReply(lines.join("\n"));
}
