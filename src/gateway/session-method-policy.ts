// Static method policy is shared by metadata discovery and runtime target resolution.
// Keep it independent of session storage so scope/profile classification does not load the runtime.
type SessionMutationTargetField = "key" | "parentSessionKey" | "sessionKey";

const SESSION_TARGET_FIELDS_BY_METHOD = new Map<string, readonly SessionMutationTargetField[]>([
  ["skills.library.activate", ["sessionKey"]],
  ["agent", ["sessionKey"]],
  ["board.event", ["sessionKey"]],
  ["board.update", ["sessionKey"]],
  ["board.widget.grant", ["sessionKey"]],
  ["board.widget.put", ["sessionKey"]],
  ["chat.abort", ["sessionKey"]],
  ["chat.inject", ["sessionKey"]],
  ["chat.send", ["sessionKey"]],
  ["mcp.app.callTool", ["sessionKey"]],
  ["mcp.app.updateModelContext", ["sessionKey"]],
  ["message.action", ["sessionKey"]],
  ["plugins.sessionAction", ["sessionKey"]],
  ["progressCard.get", ["sessionKey"]],
  ["progressCard.put", ["sessionKey"]],
  ["send", ["sessionKey"]],
  ["session.discussion.open", ["sessionKey"]],
  ["sessions.abort", ["key"]],
  ["sessions.assignOwner", ["key"]],
  ["sessions.companion.ask", ["sessionKey"]],
  ["sessions.companion.reset", ["sessionKey"]],
  ["sessions.companion.state", ["sessionKey"]],
  ["sessions.compaction.branch", ["key"]],
  ["sessions.compaction.restore", ["key"]],
  ["sessions.compact", ["key"]],
  ["sessions.create", ["key", "parentSessionKey"]],
  ["sessions.delete", ["key"]],
  ["sessions.dispatch", ["key"]],
  ["sessions.files.set", ["sessionKey"]],
  ["sessions.github.publish", ["sessionKey"]],
  ["sessions.github.confirm", ["sessionKey"]],
  ["sessions.fork", ["sessionKey"]],
  ["sessions.patch", ["key"]],
  ["sessions.goal.update", ["sessionKey"]],
  ["sessions.goal.clear", ["sessionKey"]],
  ["sessions.pluginPatch", ["key"]],
  ...(["sessions.move", "sessions.reclaim"] as const).map((method) => [method, ["key"]] as const),
  ["sessions.recover", ["key"]],
  ["sessions.reset", ["key"]],
  ["sessions.rewind", ["sessionKey"]],
  ["sessions.send", ["key"]],
  ["sessions.steer", ["key"]],
  ["sessions.branches.switch", ["sessionKey"]],
  ...(
    [
      "taskSuggestions.create",
      "talk.client.close",
      "talk.client.create",
      "talk.client.steer",
      "talk.client.toolCall",
      "talk.client.transcript",
      "talk.session.create",
      "talk.session.steer",
      "wake",
    ] as const
  ).map((method) => [method, ["sessionKey"]] as const),
  ["tools.invoke", ["sessionKey"]],
]);

const REQUIRED_SESSION_TARGET_METHODS = new Set([
  "skills.library.activate",
  "board.action",
  "board.event",
  "board.update",
  "board.widget.grant",
  "board.widget.put",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "mcp.app.callTool",
  "mcp.app.updateModelContext",
  "progressCard.get",
  "progressCard.put",
  "session.discussion.open",
  "sessions.abort",
  "sessions.assignOwner",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.companion.reset",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.delete",
  "sessions.dispatch",
  "sessions.files.set",
  "sessions.fork",
  "sessions.groups.delete",
  "sessions.groups.rename",
  "sessions.groups.update",
  "sessions.github.publish",
  "sessions.github.confirm",
  "sessions.patch",
  "sessions.goal.update",
  "sessions.goal.clear",
  "sessions.pluginPatch",
  "sessions.reclaim",
  "sessions.recover",
  "sessions.move",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
  "talk.client.close",
  "talk.client.steer",
  "talk.client.toolCall",
  "talk.client.transcript",
  "taskSuggestions.create",
]);

const APPROVAL_SESSION_TARGET_METHODS = new Set([
  "approval.resolve",
  "exec.approval.resolve",
  "plugin.approval.resolve",
]);

const READ_ONLY_SESSION_TARGET_METHODS = new Set([
  "sessions.companion.ask",
  "sessions.companion.state",
]);

const LEGACY_PROFILE_INDEPENDENT_MUTATION_METHODS = new Set([
  "talk.client.close",
  "talk.client.create",
  "talk.client.steer",
  "talk.client.toolCall",
  "talk.client.transcript",
  "talk.session.create",
  "talk.session.steer",
  "wake",
]);

export function sessionMutationTargetFields(method: string): readonly SessionMutationTargetField[] {
  return READ_ONLY_SESSION_TARGET_METHODS.has(method)
    ? []
    : (SESSION_TARGET_FIELDS_BY_METHOD.get(method) ?? []);
}

export function isRequiredSessionTargetMethod(method: string): boolean {
  return REQUIRED_SESSION_TARGET_METHODS.has(method);
}

export function isApprovalSessionTargetMethod(method: string): boolean {
  return APPROVAL_SESSION_TARGET_METHODS.has(method);
}

export function isSessionProfileDependentMethod(method: string): boolean {
  if (LEGACY_PROFILE_INDEPENDENT_MUTATION_METHODS.has(method)) {
    return false;
  }
  return (
    SESSION_TARGET_FIELDS_BY_METHOD.has(method) ||
    REQUIRED_SESSION_TARGET_METHODS.has(method) ||
    APPROVAL_SESSION_TARGET_METHODS.has(method) ||
    method === "sessions.patchMany"
  );
}
