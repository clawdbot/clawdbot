import {
  stripTargetKindPrefix,
  stripTargetProviderPrefix,
} from "../../infra/outbound/channel-target-prefix.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { CronJob } from "../types.js";

/**
 * Picks the session-key identity used to resolve a cron delivery's outbound route.
 *
 * An isolated run does not carry its bound source conversation's namespace.
 * Reuse only a canonical conversation belonging to the same agent, actual
 * delivery provider, and destination; otherwise jobs can adopt another peer's
 * conversation or thread.
 */
export function selectCronRouteCurrentSessionKey(
  job: CronJob,
  agentSessionKey: string,
  deliveryProvider: string,
  deliveryTarget: string,
): string {
  const bound = (job.sessionKey ?? "").trim();
  const parsedBound = parseAgentSessionKey(bound);
  const parsedRun = parseAgentSessionKey(agentSessionKey);
  if (!parsedBound || !parsedRun || parsedBound.agentId !== parsedRun.agentId) {
    return agentSessionKey;
  }
  const conversation = /^([^:]+):(direct|group|channel):([^:]+)(?::thread:[^:]+)?$/i.exec(
    parsedBound.rest,
  );
  const targetPeerId = stripTargetKindPrefix(
    stripTargetProviderPrefix(deliveryTarget, deliveryProvider),
  );
  if (
    conversation?.[1]?.toLowerCase() !== deliveryProvider.trim().toLowerCase() ||
    conversation[3] !== targetPeerId
  ) {
    return agentSessionKey;
  }
  return bound;
}
