import { isSessionProfileDependentMethod } from "../session-sharing-target-input.js";

const PROFILE_DEPENDENT_CORE_METHODS = new Set([
  "agent.wait",
  // talk.config projects the caller's profile accent; without this gate a
  // client asking during the post-hello GitHub identity sync window would get
  // the gateway-wide accent instead. Profile-less clients pass through.
  "talk.config",
  "ui.command",
  "users.linkEmail",
  "users.setAvatar",
  "users.setDisplayName",
  "users.setRole",
]);
const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "openclaw.approval.",
  "openclaw.chat",
  "progressCard.",
  "projects.",
  "secrets.",
  "session.",
  "sessions.",
  "taskSuggestions.",
  "tasks.",
  "terminal.",
  "users.prefs.",
  "users.github.",
  "skills.library.",
] as const;

/** Classifies core methods whose behavior reads or mutates durable user/session ownership. */
export function isCoreGatewayMethodProfileDependent(method: string): boolean {
  return (
    isSessionProfileDependentMethod(method) ||
    PROFILE_DEPENDENT_CORE_METHODS.has(method) ||
    PROFILE_DEPENDENT_CORE_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}
