// Compact built-in summaries shown in tool inventories and model-facing tool
// descriptions when a longer contextual description is assembled elsewhere.
export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, cron, wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions; filters/previews.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized session history.";
export const SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY = "Search past session transcripts.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Run same-Gateway session/agent.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn subagent or ACP session.";
export const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn subagent session.";
export const AGENTS_WAIT_TOOL_DISPLAY_SUMMARY = "Wait for collector subagents.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status/model/usage.";
export const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track short work plan.";
export const ASK_USER_TOOL_DISPLAY_SUMMARY = "Ask the user and wait for an answer.";
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
    "Run a visible session on this Gateway by sessionKey/label, or a configured local agent by agentId; sessionKey wins redundant label.",
    "A session identifies model context, not an external address; its reply may still announce through established delivery context.",
    "For an exact external destination, use `conversations_list` plus `conversations_send`/`conversations_turn`, or `message` with an explicit channel and target.",
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
    '`visible=true`: persistent dashboard session; subagent only; omit `mode` (no `mode="run"`), `thread`, `thinking`, `lightContext`, `attachments`, `attachAs`; inherited tool allow/denylist blocks it at spawn with no config override.',
    "Session listing/addressing obeys `tools.sessions.visibility` (`tree` default: current + own spawn subtree).",
    "Inherits parent workspace. Native task arrives as first `[Subagent Task]`.",
    'Native transcript needed: `context="fork"`; else omit/isolated.',
    "Use fresh child for sidecar/parallel batch reads, multi-step search, data collection; avoid quick lookup/single read unless policy prefers.",
    completionGuidance,
  ];
  if (options?.acpAvailable === false) {
    return baseDescription.join(" ");
  }
  return [
    ...baseDescription.slice(0, 5),
    '`runtime="acp"` ids: codex, claude, gemini, opencode, or configured ACP.',
    ...baseDescription.slice(5),
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
  return "Use for multi-step work. Send the full list each call; keep statuses current and exactly one `in_progress` until done.";
}

/** Describes the ask_user tool and its decision-only use policy. */
export function describeAskUserTool(): string {
  return [
    "Ask the human user 1-3 structured questions and wait for their answer.",
    "Use only when blocked on a decision genuinely theirs that cannot be resolved from the request, code, or sensible defaults; never ask whether to proceed or confirm a plan.",
    "Prefer one question. Put the recommended option first and suffix its label with ` (Recommended)`.",
    "Do not include an Other option; free text is added automatically.",
    "If the result is no_answer, continue with best judgment.",
  ].join(" ");
}
