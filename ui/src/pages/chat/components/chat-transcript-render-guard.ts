import { guard } from "lit/directives/guard.js";
import type { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import type { ChatThreadState } from "./chat-thread-interactions.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

function itemDependencies(item: ChatRenderItem): readonly unknown[] {
  if (item.kind === "stream-run") {
    return [item.key, ...item.parts];
  }
  if (item.kind === "work-group") {
    return [item.key, item.durationMs, ...item.groups];
  }
  if (item.kind === "activity-run") {
    return [item.key, ...item.groups];
  }
  if (item.kind === "agent-run-frame") {
    const outcome = item.outcome;
    // Grouping recreates frame wrappers; only the outcome and nested content invalidate a row.
    return [
      item.key,
      outcome.kind,
      outcome.kind === "completed" ? outcome.actionOwner : null,
      ...item.parts.flatMap(itemDependencies),
    ];
  }
  return [item];
}

export function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): void {
  const previous = state.transcriptRenderDependencies;
  if (
    previous.length !== dependencies.length ||
    dependencies.some((value, index) => !Object.is(previous[index], value))
  ) {
    state.transcriptRenderDependencies = dependencies;
    state.transcriptRenderContext = {};
  }
}

export function guardChatRenderItems(
  state: ChatThreadState,
  // Live status ownership depends on sibling rows, while usage patches can
  // update a visible indicator without changing the row itself.
  liveStatus: (item: ChatRenderItem) => string,
  render: (item: ChatRenderItem) => unknown,
) {
  return (item: ChatRenderItem) =>
    guard([...itemDependencies(item), state.transcriptRenderContext, liveStatus(item)], () =>
      render(item),
    );
}
