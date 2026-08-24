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
    return [item.key, item.outcome, ...item.parts];
  }
  return [item];
}

export function trackTranscriptRenderDependencies(
  state: ChatThreadState,
  dependencies: unknown[],
): unknown[] {
  const previous = state.transcriptRenderDependencies;
  const nextLength = dependencies.length - 1;
  let changed = previous.length !== nextLength;
  for (let index = 0; !changed && index < nextLength; index += 1) {
    changed = !Object.is(previous[index], dependencies[index + 1]);
  }
  if (changed) {
    // The first dependency is chatItems. Keep the shared context stable when
    // only the live row changes, but invalidate every row for presentation changes.
    state.transcriptRenderDependencies = dependencies.slice(1);
    state.transcriptRenderContext = {};
  }
  return dependencies;
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
