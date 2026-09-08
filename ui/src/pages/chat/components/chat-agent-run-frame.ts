import { html, nothing } from "lit";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import {
  agentRunFrameActiveStatusParts,
  agentRunFrameGroups,
  type AgentRunFrameRenderItem,
} from "../chat-agent-run-grouping.ts";
import type { TurnRecap } from "../chat-progress.ts";
import {
  renderActivityGroup,
  renderMessageGroup,
  renderMessageGroupContent,
  renderStreamGroup,
  renderStreamGroupParts,
  renderWorkGroupSummary,
  type StreamGroupOptions,
} from "./chat-message.ts";
import { renderBrowserTabPreviews } from "./chat-tool-cards.ts";

type MessageGroupRenderOptions = Parameters<typeof renderMessageGroup>[1];

type AgentRunFrameOptions = {
  streamOptions: StreamGroupOptions;
  renderGroupOptions: (group: MessageGroup) => MessageGroupRenderOptions;
  isWorkExpanded: (key: string) => boolean;
  onToggleWork: (key: string, expanded: boolean) => void;
  turnRecap?: TurnRecap;
};

export function renderAgentRunFrame(frame: AgentRunFrameRenderItem, opts: AgentRunFrameOptions) {
  const statusParts = agentRunFrameActiveStatusParts(frame);
  if (statusParts) {
    return renderStreamGroup(statusParts, opts.streamOptions);
  }
  const groups = agentRunFrameGroups(frame);
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const actionOwner = frame.outcome.kind === "completed" ? frame.outcome.actionOwner : null;
  const representative = firstAssistant ?? groups[0];
  const streamStarts = frame.parts.flatMap((part) =>
    part.kind === "stream-run" ? part.parts.map((streamPart) => streamPart.startedAt) : [],
  );
  const shell: MessageGroup = {
    key: frame.key,
    kind: "group",
    role: "assistant",
    senderLabel: firstAssistant?.senderLabel,
    replyToSender: firstAssistant?.replyToSender,
    messages: representative?.messages ?? [],
    visibleContent: representative?.visibleContent ?? "none",
    timestamp: Math.min(...groups.map((group) => group.timestamp), ...streamStarts, Date.now()),
    isStreaming: frame.outcome.kind === "active",
    runId: frame.runId,
  };
  const renderFrameGroup = (group: MessageGroup) =>
    renderMessageGroupContent(group, opts.renderGroupOptions(group));
  const frameContent = frame.parts.map((part) => {
    if (part.kind === "stream-run") {
      // The frame owns layout continuity; the indicator stays standalone so
      // its visible claw remains present alongside streamed text.
      return renderStreamGroupParts(part.parts, opts.streamOptions, "standalone");
    }
    if (part.kind === "work-group") {
      const expanded = opts.isWorkExpanded(part.key);
      return html`
        ${renderWorkGroupSummary(part, {
          expanded,
          onToggle: () => opts.onToggleWork(part.key, expanded),
          presentation: "continuation",
          browserTabPreviews: renderBrowserTabPreviews(part.groups, opts.renderGroupOptions(shell)),
        })}
        ${expanded ? part.groups.map(renderFrameGroup) : nothing}
      `;
    }
    if (part.kind === "activity-run") {
      const firstGroup = part.groups[0];
      return firstGroup
        ? renderActivityGroup(part.groups, opts.renderGroupOptions(firstGroup), "continuation")
        : nothing;
    }
    return renderFrameGroup(part);
  });
  return renderMessageGroup(shell, {
    ...opts.renderGroupOptions(shell),
    frameContent,
    frameActionOwner: actionOwner,
    turnRecap: opts.turnRecap,
  });
}
