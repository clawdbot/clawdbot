// Compact built-in summaries shown in tool inventories and model-facing tool
// descriptions when a longer contextual description is assembled elsewhere.
export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, cron, wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions; filters/previews.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized session history.";
export const SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY = "Search past session transcripts.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Message session or configured agent.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn subagent or ACP session.";
export const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn subagent session.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status/model/usage.";
export const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track short work plan.";
export const SPAWN_TASK_TOOL_DISPLAY_SUMMARY = "Suggest follow-up work for operator approval.";
export const DISMISS_TASK_TOOL_DISPLAY_SUMMARY = "Withdraw a pending task suggestion.";

/** Describes the sessions_list tool for model-facing instructions. */
export function describeSessionsListTool(): string {
  return [
    "List visible sessions; filter kind/label/agentId/search/activity/archive.",
    "Use before history/send target selection.",
  ].join(" ");
}

/** Describes the sessions_history tool for model-facing instructions. */
export function describeSessionsHistoryTool(): string {
  return [
    "Read sanitized visible-session history.",
    "Before reply/debug/resume. Supports limit, offset, search-result sessionId/messageId anchors, and tool messages.",
  ].join(" ");
}

/** Describes the sessions_search tool for model-facing instructions. */
export function describeSessionsSearchTool(): string {
  return [
    "Search your own past sessions for matching user and assistant text.",
    "Follow up with sessions_history using a returned sessionKey, sessionId, and messageId for neighboring context.",
  ].join(" ");
}

/** Describes the sessions_send tool for model-facing instructions. */
export function describeSessionsSendTool(): string {
  return [
    "Message visible session by sessionKey/label, or configured agent by agentId; sessionKey wins redundant label.",
    "Thread chats rejected: target parent channel. Missing configured-agent main created. Waits for reply when available.",
    "watch:true: notice arrives when others later change target session.",
  ].join(" ");
}

/** Describes the sessions_spawn tool for model-facing instructions. */
export function describeSessionsSpawnTool(options?: {
  acpAvailable?: boolean;
  threadAvailable?: boolean;
}): string {
  const runtimeDescription =
    options?.acpAvailable === false
      ? 'Spawn clean child; default `runtime="subagent"`.'
      : 'Spawn clean child; default `runtime="subagent"`; ACP needs explicit `runtime="acp"`.';
  const sessionCompletionGuidance =
    options?.acpAvailable === false
      ? "After spawn, do non-overlap work. Run result returns; session output stays thread."
      : 'After spawn, do non-overlap work. Run result returns; session output stays thread unless ACP `streamTo="parent"`.';
  const completionGuidance = options?.threadAvailable
    ? sessionCompletionGuidance
    : "After spawn, do non-overlap work while run result returns.";
  const baseDescription = [
    runtimeDescription,
    options?.threadAvailable
      ? '`mode="run"` one-shot; `mode="session"` persistent/thread-bound only on supporting requester channel.'
      : '`mode="run"` one-shot background.',
    "Inherits parent workspace. Native task arrives as first `[Subagent Task]`.",
    'Native transcript needed: `context="fork"`; else omit/isolated.',
    "Use fresh child for sidecar/parallel batch reads, multi-step search, data collection; avoid quick lookup/single read unless policy prefers.",
    completionGuidance,
  ];
  if (options?.acpAvailable === false) {
    return baseDescription.join(" ");
  }
  return [
    ...baseDescription.slice(0, 3),
    '`runtime="acp"` ids: codex, claude, gemini, opencode, or configured ACP.',
    ...baseDescription.slice(3),
  ].join(" ");
}

/** Describes the session_status tool for model-facing instructions. */
export function describeSessionStatusTool(): string {
  return [
    "Show visible-session model/usage/time/cost/tasks.",
    '`sessionKey="current"` for current; UI labels are not keys.',
    "`model` overrides; `model=default` resets. Use for active model/session questions.",
  ].join(" ");
}

/** Describes the update_plan tool for model-facing instructions. */
export function describeUpdatePlanTool(): string {
  return [
    "Update run plan for non-trivial multi-step work; keep current.",
    "Short steps; max one `in_progress`; skip simple one-step.",
  ].join(" ");
}
