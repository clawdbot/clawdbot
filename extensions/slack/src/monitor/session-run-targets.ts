import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";

type SlackSessionAddress = {
  channelId: string;
  threadTs?: string;
  eventScope?: SlackEventScope;
};

type SlackSessionRunTarget = {
  route: ResolvedAgentRoute;
  isActive: () => boolean;
};

export function captureSlackSessionTargetGuard(
  ctx: SlackMonitorContext,
  route: ResolvedAgentRoute,
  isActive?: () => boolean,
): () => boolean {
  const scope = {
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId }),
  };
  const selected = getSessionEntry(scope);
  return () => {
    const current = getSessionEntry(scope);
    // A pending publisher can lack a stored entry. It cannot lend Stop authority
    // to a future incarnation merely because the logical session key matches.
    return (
      isActive?.() !== false &&
      current?.sessionId === selected?.sessionId &&
      current?.lifecycleRevision === selected?.lifecycleRevision
    );
  };
}

// Reloaded turn contexts inherit the same Bolt app; each new monitor owns a new app.
const runs = new WeakMap<SlackMonitorContext["app"], Map<string, Set<SlackSessionRunTarget>>>();

function addressKey(address: SlackSessionAddress): string {
  return JSON.stringify([address.eventScope?.teamId ?? "", address.channelId, address.threadTs]);
}

/** Registers the exact publisher before status/output; the dispatch owner must release it. */
export function registerSlackSessionRun(
  ctx: SlackMonitorContext,
  address: SlackSessionAddress,
  route: ResolvedAgentRoute,
): () => void {
  if (!address.threadTs) {
    return () => {};
  }
  const byAddress = runs.get(ctx.app) ?? new Map<string, Set<SlackSessionRunTarget>>();
  runs.set(ctx.app, byAddress);
  const key = addressKey(address);
  const targets = byAddress.get(key) ?? new Set<SlackSessionRunTarget>();
  byAddress.set(key, targets);
  const target = { route, isActive: () => targets.has(target) };
  targets.add(target);
  return () => {
    targets.delete(target);
    // A completed dispatch must not erase another publisher or a replacement registration.
    if (targets.size === 0 && byAddress.get(key) === targets) {
      byAddress.delete(key);
    }
  };
}

export function getSlackSessionRuns(
  ctx: SlackMonitorContext,
  address: SlackSessionAddress,
): SlackSessionRunTarget[] {
  const targets = [...(runs.get(ctx.app)?.get(addressKey(address)) ?? [])];
  return [...new Map(targets.map((target) => [target.route.sessionKey, target])).values()].map(
    (target) => ({
      route: target.route,
      isActive: () =>
        targets.some(
          (candidate) =>
            candidate.route.sessionKey === target.route.sessionKey && candidate.isActive(),
        ),
    }),
  );
}
