import { isSessionProfileDependentMethod } from "../session-method-policy.js";

const PROFILE_DEPENDENT_CORE_METHODS = new Set([
  "agent.wait",
  // Wait for post-hello identity enrichment so an identified caller does not
  // cache a shared-only catalog before their personal accounts are available.
  "models.list",
  // talk.config projects the caller's profile accent; without this gate a
  // client asking during the post-hello GitHub identity sync window would get
  // the gateway-wide accent instead. Profile-less clients pass through.
  "talk.config",
  "ui.command",
  "users.linkAuthProfile",
  "users.linkEmail",
  "users.listAuthLinks",
  "users.listModelAccounts",
  "users.selectModelAccount",
  "users.mentionable",
  "users.setAvatar",
  "users.setDisplayName",
  "users.setRole",
  "users.unlinkAuthProfile",
]);
const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "mentions.",
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
  "users.authConnect.",
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
