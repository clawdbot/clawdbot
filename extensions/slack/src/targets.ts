// Slack plugin module implements targets behavior.
import { parseSlackTarget, slackTargetsMatch } from "./target-parsing.js";

function matchesResolvedUserTarget(target: string, currentMessagingTarget: string): boolean {
  const resolvedId = target.trim();
  if (!/^[UW][A-Z0-9]+$/i.test(resolvedId)) {
    return false;
  }
  const currentTarget = parseSlackTarget(currentMessagingTarget);
  return (
    currentTarget?.kind === "user" && currentTarget.id.toLowerCase() === resolvedId.toLowerCase()
  );
}

export function slackContextTargetsMatch(
  target: string,
  context: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
  },
): boolean {
  return Boolean(
    (context.currentMessagingTarget &&
      (slackTargetsMatch(target, context.currentMessagingTarget) ||
        // Core target resolution removes the user: prefix before auto-thread selection.
        matchesResolvedUserTarget(target, context.currentMessagingTarget))) ||
    (context.currentChannelId && slackTargetsMatch(target, context.currentChannelId)),
  );
}

export {
  looksLikeSlackTargetId,
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
} from "./target-parsing.js";
export type { SlackTarget, SlackTargetKind, SlackTargetParseOptions } from "./target-parsing.js";
