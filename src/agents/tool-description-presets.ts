// Compact built-in summaries shown in tool inventories and model-facing tool
// descriptions when a longer contextual description is assembled elsewhere.
export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, automations, wake events.";
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
export const SUGGEST_TASK_TOOL_DISPLAY_SUMMARY = "Suggest follow-up work for operator approval.";
export const DISMISS_TASK_TOOL_DISPLAY_SUMMARY = "Withdraw a pending task suggestion.";

export function describeAgentsListTool(sessionsSpawnAvailable: boolean): string {
  return sessionsSpawnAvailable
    ? 'List configured agent ids with name/model/runtime metadata, allowed as `sessions_spawn(runtime:"subagent")` targets.'
    : "List configured agent ids with name/model/runtime metadata that can be used as subagent spawn targets.";
}

export function describeAgentsWaitTool(sessionsSpawnAvailable: boolean): string {
  const targets = sessionsSpawnAvailable
    ? "collector subagents started by sessions_spawn collect=true"
    : "collector subagent runs";
  return `Wait for ${targets}. Accepts many run ids; returns once any completes (completed results incl. structured output, plus pending ids), or on timeoutSeconds.`;
}

// Mirrors plugin-sdk SessionToolsVisibility; kept local because importing that
// module here would close an agents<->plugin-sdk madge cycle. Call sites pass
// the policy union, so a new mode fails compilation at every consumer.
type SessionVisibilityScope = "self" | "tree" | "agent" | "all";

// Single source for model-facing session-visibility scope wording; every tool
// description or warning that explains visibility renders through this so the
// prose cannot drift from the session-visibility checker (openclaw#114797).
const SESSION_VISIBILITY_SCOPE_COPY = {
  self: "current session only",
  tree: "current session + own spawn subtree; the main session sees all sessions of its agent",
  agent: "all sessions of this agent",
  all: "all sessions, cross-agent per tools.agentToAgent",
} satisfies Record<SessionVisibilityScope, string>;

export function describeSessionVisibilityScope(
  visibility: SessionVisibilityScope,
  options?: { spawnRestricted?: boolean },
): string {
  // Sandboxed sessions under the "spawned" clamp list/read only spawned rows.
  if (options?.spawnRestricted && visibility === "tree") {
    return "current session + own spawn subtree (sandbox: spawned sessions only)";
  }
  return SESSION_VISIBILITY_SCOPE_COPY[visibility];
}

type SessionLinkDescriptionOptions = { sessionLinkBase?: string };

function describeSessionLinkLine(base: string): string {
  return `When pointing the user at a session, cite its Control UI URL: main session -> \`${base}/chat/<agentId>\`; any other display session key -> \`${base}/chat/\` + key without leading \`agent:\`, with \`:\` replaced by \`/\`.`;
}

/** Describes the sessions_list tool for model-facing instructions. */
export function describeSessionsListTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "List visible sessions; filter kind/label/agentId/search/activity/archive.",
    "Preview recent messages inline via includeLastMessage/messageLimit; includeDerivedTitles adds derived titles.",
    "Use before history/send target selection.",
    ...(options?.sessionLinkBase ? [describeSessionLinkLine(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_history tool for model-facing instructions. */
export function describeSessionsHistoryTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Read sanitized visible-session history.",
    "Before reply/debug/resume. Supports limit, offset, search-result sessionId/messageId anchors, and tool messages.",
    ...(options?.sessionLinkBase ? [describeSessionLinkLine(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_search tool for model-facing instructions. */
export function describeSessionsSearchTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Search your own past sessions for matching user and assistant text.",
    "Follow up with sessions_history using a returned sessionKey, sessionId, and messageId for neighboring context.",
    ...(options?.sessionLinkBase ? [describeSessionLinkLine(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_send tool for model-facing instructions. */
export function describeSessionsSendTool(): string {
  return [
    "Run a visible session on this Gateway by sessionKey/label, or a configured local agent by agentId; sessionKey wins redundant label.",
    "A session identifies model context, not an external address; its reply may still announce through established delivery context.",
    "For an exact external destination, use `conversations_list` plus `conversations_send`/`conversations_turn`.",
    "Thread chats rejected: target parent channel. Missing configured-agent main created. Waits for reply when available.",
    "watch:true: notice arrives when others later change target session.",
  ].join(" ");
}

/** Describes the sessions_spawn tool for model-facing instructions. */
export function describeSessionsSpawnTool(options?: {
  acpAvailable?: boolean;
  threadAvailable?: boolean;
  swarmEnabled?: boolean;
  sessionToolsVisibility?: SessionVisibilityScope;
  spawnRestricted?: boolean;
}): string {
  // Callers that resolve the effective visibility get it rendered as fact;
  // without it the copy must keep the "default" hedge instead of asserting tree.
  const visibilityLine = options?.sessionToolsVisibility
    ? `Session listing/addressing obeys \`tools.sessions.visibility\` (${options.sessionToolsVisibility}: ${describeSessionVisibilityScope(options.sessionToolsVisibility, { spawnRestricted: options.spawnRestricted })}).`
    : `Session listing/addressing obeys \`tools.sessions.visibility\` (\`tree\` default: ${describeSessionVisibilityScope("tree")}).`;
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
  return [
    runtimeDescription,
    options?.threadAvailable
      ? '`mode="run"` one-shot; `mode="session"` persistent/thread-bound only on supporting requester channel.'
      : '`mode="run"` one-shot background.',
    "`agentId` targets a configured agent (see agents_list); `model` overrides its model; `cleanup` delete|keep hidden child session; `sandbox` inherit|require.",
    '`visible=true`: persistent sidebar dashboard session; use when the user asks to create/open a thread; subagent only; omit `mode` (no `mode="run"`), `thread`, `thinking`, `lightContext`, `attachments`, `attachAs`; inherits the caller tool-policy ceiling; may check out a git worktree via `worktree`/`worktreeName`/`worktreeBaseRef`. When its accepted result includes `sessionUrl`, channel acknowledgements put the session URL on the first line and `Owner: <label>` on the second line.',
    visibilityLine,
    ...(options?.swarmEnabled
      ? [
          "`collect=true` (swarm): parallel fan-out collector children; structured result per `outputSchema`; `groupId` groups a batch; await with agents_wait.",
        ]
      : []),
    "Inherits parent workspace. Native task arrives as first `[Subagent Task]`.",
    ...(options?.acpAvailable === false
      ? []
      : ['`runtime="acp"` ids: codex, claude, gemini, opencode, or configured ACP.']),
    'Native transcript needed: `context="fork"`; else omit/isolated.',
    "Use fresh child for sidecar/parallel batch reads, multi-step search, data collection; avoid quick lookup/single read unless policy prefers.",
    completionGuidance,
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
  return "Maintain a user-visible work plan: ordered steps, each pending/in_progress/completed. Use for multi-step work. Send the full list each call; keep statuses current and exactly one `in_progress` until done.";
}

/** Describes the ask_user tool and its decision-only use policy. */
export function describeAskUserTool(): string {
  return [
    "Ask the human user 1-3 structured questions and wait for their answer; `multiSelect` allows picking several options and `timeoutSeconds` bounds the wait.",
    "Use only when blocked on a decision genuinely theirs that cannot be resolved from the request, code, or sensible defaults; never ask whether to proceed or confirm a plan.",
    "Prefer one question. Put the recommended option first and suffix its label with ` (Recommended)`.",
    "Do not include an Other option; free text is added automatically.",
    "If the result is no_answer, continue with best judgment.",
  ].join(" ");
}
