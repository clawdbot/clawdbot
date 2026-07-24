import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { CronJob } from "../types.js";

/**
 * Picks the session-key identity used to resolve a cron delivery's outbound route.
 *
 * An isolated cron run does not carry the source conversation's namespace. Prefer
 * a bound canonical Mattermost conversation so private channels retain `group:<id>`.
 * Keep this provider-specific because other adapters have their own current-session
 * semantics and are outside #95646.
 */
export function selectCronRouteCurrentSessionKey(job: CronJob, agentSessionKey: string): string {
  const bound = (job.sessionKey ?? "").trim();
  const parsed = parseAgentSessionKey(bound);
  if (parsed && /^mattermost:(direct|group|channel):[^:]+(?::thread:[^:]+)?$/i.test(parsed.rest)) {
    return bound;
  }
  return agentSessionKey;
}
