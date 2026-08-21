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

const GENERATED_MEDIA_COMPLETION_SOURCES = new Set<AgentInternalEventSource>([
  "image_generation",
  "video_generation",
  "music_generation",
]);

export type AgentInternalEventSource = (typeof AGENT_INTERNAL_EVENT_SOURCES)[number];
export type AgentInternalEventStatus = (typeof AGENT_INTERNAL_EVENT_STATUSES)[number];

/**
 * Total read for the "did the child produce output" fact on a completion event.
 *
 * `noVisibleResult` is recorded by the producer that substituted placeholder
 * copy into `result`; delivery gates consult it instead of matching the
 * placeholder wording, so display copy and control flow stay independent.
 * Absence means the ordinary case — `result` carries the child's own output —
 * which keeps payloads from producers that always have output byte-identical.
 */
export function hasVisibleCompletionResult(event: { noVisibleResult?: boolean }): boolean {
  return event.noVisibleResult !== true;
}

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
