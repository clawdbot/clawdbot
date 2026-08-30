// Compact built-in summaries shown in tool inventories and model-facing tool
// descriptions when a longer contextual description is assembled elsewhere.
export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect/control exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule reminders, automations, wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY = "List visible sessions; filters/previews.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY = "Read sanitized session history.";
export const SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY = "Search past session transcripts.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Run same-Gateway session/agent.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY =
  "Spawn hidden subagent (ephemeral) or visible work session (durable).";
export const SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY = "Spawn subagent session.";
export const AGENTS_WAIT_TOOL_DISPLAY_SUMMARY = "Wait for collector subagents.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status/model/usage.";
export const ASK_USER_TOOL_DISPLAY_SUMMARY = "Ask the user and wait for an answer.";
export const SUGGEST_TASK_TOOL_DISPLAY_SUMMARY = "Suggest follow-up work for operator approval.";
export const DISMISS_TASK_TOOL_DISPLAY_SUMMARY = "Withdraw a pending task suggestion.";
export const SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY =
  "Manage reusable-skill proposals; inspect can select one stored artifact and returns complete content only when it fits the model budget.";

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

export function describeSessionLinkRule(base: string): string {
  return `When pointing the user at a session, cite its Control UI URL: main session -> \`${base}/chat/<agentId>\`; any other display session key -> \`${base}/chat/<agentId>/~key/\` + key minus \`agent:<agentId>:\`, with \`:\` replaced by \`/\`.`;
}

/** Describes the sessions_list tool for model-facing instructions. */
export function describeSessionsListTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "List visible sessions and sidebar groups; filter kind/label/agentId/search/activity/archive.",
    "Preview recent messages inline via includeLastMessage/messageLimit; includeDerivedTitles adds derived titles.",
    "Use before history/send target selection.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_history tool for model-facing instructions. */
export function describeSessionsHistoryTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Read sanitized visible-session history.",
    "Before reply/debug/resume. Supports limit, offset, search-result sessionId/messageId anchors, and tool messages.",
    "pendingInputs are accepted inputs outside model history; page with pendingBefore=nextBefore. Cancelled/interrupted inputs never replay automatically. Lower limit for richer pending previews.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_search tool for model-facing instructions. */
export function describeSessionsSearchTool(options?: SessionLinkDescriptionOptions): string {
  return [
    "Search your own past sessions for matching user and assistant text.",
    ...(options?.sessionLinkBase ? [describeSessionLinkRule(options.sessionLinkBase)] : []),
  ].join(" ");
}

/** Describes the sessions_send tool for model-facing instructions. */
export function describeSessionsSendTool(): string {
  return [
    "Run a visible session on this Gateway by sessionKey/label, or a configured local agent by agentId; sessionKey wins redundant label.",
    "A session identifies model context, not an external address; its reply may still announce through established delivery context.",
    'Thread chats rejected: target parent channel. Missing configured-agent main created. Waits for reply when available; status "no_reply" is terminal, so do not wait for an announcement.',
    "watch:true: notice arrives when others later change target session.",
  ].join(" ");
}

export function describeSubagentSpawnContext(threadAvailable: boolean): string {
  return [
    'Native: explicit context="isolated" starts clean; context="fork" copies requester transcript and requires the same agent.',
    threadAvailable
      ? "Omitted context follows configured threadBindings.defaultSpawnContext policy (fork by default) with thread=true; without a thread it is isolated."
      : "Omitted context is isolated.",
  ].join(" ");
}

/** Describes the sessions_spawn tool for model-facing instructions. */
export function describeSessionsSpawnTool(options?: {
  acpAvailable?: boolean;
  threadAvailable?: boolean;
  subagentThreadAvailable?: boolean;
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
      ? 'Spawn child session; default `runtime="subagent"`.'
      : 'Spawn child session; default `runtime="subagent"`; ACP needs explicit `runtime="acp"`.';
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
    "`agentId` targets a configured agent; `model` overrides its model; `cleanup` delete|keep hidden child session; `sandbox` inherit|require.",
    '`visible=true`: durable visible session. Default for coding, multi-step work, or results user may revisit/steer/keep — not only when a thread is requested. Shows in web UI sidebar; works without UI: completion announces back, progress checkable. `group` places it in a custom sidebar group (a new name creates the group); omission or an empty string leaves it ungrouped. Subagent only; omit `mode` (`mode="run"` is also accepted), `thread`, `thinking`, and `lightContext`; `attachments=[]` and omitted/blank `attachAs.mountPath` are accepted, but nonempty attachment staging is unsupported; inherits the caller tool-policy ceiling; may check out a git worktree via `worktree`/`worktreeName`/`worktreeBaseRef`. When its accepted result includes `sessionUrl`, channel acknowledgements put the session URL on the first line and `Owner: <label>` on the second line.',
    visibilityLine,
    ...(options?.swarmEnabled
      ? [
          "`collect=true` (swarm): parallel fan-out collector children; structured result per `outputSchema`; `groupId` groups a batch.",
        ]
      : []),
    "Inherits parent workspace. Native task arrives in the child's initial `[Subagent Task]` message.",
    ...(options?.acpAvailable === false
      ? []
      : ['`runtime="acp"` ids: codex, claude, gemini, opencode, or configured ACP.']),
    describeSubagentSpawnContext(options?.subagentThreadAvailable === true),
    "Hidden child: research, parallel/batch reads, throwaway side tasks. Coding, PRs, long builds, anything worth keeping: `visible=true`. No spawn for quick lookup/single read.",
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

/** Describes the ask_user tool and its decision-only use policy. */
export function describeAskUserTool(): string {
  return [
    "Ask the human user 1-3 structured questions and wait for their answer; `multiSelect` allows picking several options and `timeoutSeconds` bounds the wait.",
    "Use only when blocked on a decision genuinely theirs that cannot be resolved from the request, code, or sensible defaults; never ask whether to proceed or confirm a plan.",
    "Ask exactly one question per call unless several answers must be submitted together; one single-select question uses native controls on supported messaging channels.",
    "Put every selectable choice in `options`, never only in the question text. Put the recommended option first and suffix its label with ` (Recommended)`.",
    "Use `multiSelect` only when the user may choose several options at once; otherwise omit it.",
    "Do not include an Other option; free text is added automatically.",
    "If the result is no_answer, continue with best judgment.",
  ].join(" ");
}

/** Describes the secrets tool and the store semantics the model cannot observe. */
export function describeSecretsTool(): string {
  return [
    "Obtain and manage credentials you never see: `request` asks the human to type a value into a trusted prompt that stores it directly, `list` returns entry metadata, and `delete` removes an entry.",
    "A requested value is never readable back by any action; use `request` when you need a credential you do not have instead of asking for one in conversation, and never repeat a credential a human pasted into chat.",
    "`request` blocks until the human answers, so ask only for a credential the current task actually needs.",
    "Only protected secrets may be requested, and they reach a service through config references or, where the egress proxy is enabled, substitution into outbound requests; plain environment values are set by the operator in Settings or the CLI, never requested here.",
    "List every hostname that will receive the value in `allowedHosts`: a secret with no allowed hosts can never be substituted, so the request silently produces an unusable credential.",
    '`reason` is shown to the human deciding whether to provide the value. Stored entries are referenced elsewhere as {source:"store", id:NAME}; if the result is no_answer, continue with best judgment.',
  ].join(" ");
}
