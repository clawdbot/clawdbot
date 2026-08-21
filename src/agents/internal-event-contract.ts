// Internal event discriminants shared by runtime event producers and prompt
// formatters. Keep values stable because they cross agent runtime boundaries.
export const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION = "task_completion" as const;

const AGENT_INTERNAL_EVENT_SOURCES = [
  "subagent",
  "cron",
  "image_generation",
  "video_generation",
  "music_generation",
] as const;

const AGENT_INTERNAL_EVENT_STATUSES = ["ok", "timeout", "error", "unknown"] as const;

const AGENT_RUN_DISPOSITIONS = ["exited", "killed", "still-running"] as const;

const GENERATED_MEDIA_COMPLETION_SOURCES = new Set<AgentInternalEventSource>([
  "image_generation",
  "video_generation",
  "music_generation",
]);

export type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
export type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];
/**
 * Who stopped, as opposed to `status` (how the wait ended). A `timeout` status
 * alone cannot tell "the child stopped" from "I stopped waiting for the child",
 * and reporting the second as the first invites a parent to spawn a successor
 * onto working state its live child still owns. `still-running` means only the
 * waiter ended: the run is live and its handle stays harvestable.
 */
export type AgentRunDisposition = (typeof AGENT_RUN_DISPOSITIONS)[number];

/** Identifies completion events that can resume an exact cron run. */
export function hasGeneratedMediaCompletionEvent(
  events?: readonly { type: string; source: AgentInternalEventSource }[],
): boolean {
  return Boolean(
    events?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION &&
        GENERATED_MEDIA_COMPLETION_SOURCES.has(event.source),
    ),
  );
}
