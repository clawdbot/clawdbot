import { listAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";

type ResolvedRoute = ReturnType<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>;

export type AgentRouteResolution =
  | { ok: true; route: ResolvedRoute }
  | { ok: false; unknownAgentId: string };

/**
 * Resolve the route for an AG-UI request, honouring `X-OpenClaw-Agent-Id`.
 *
 * The header names the agent that runs the turn. It must NOT be passed to
 * `resolveAgentRoute` as `accountId`: that value only feeds channel-account
 * bindings, so an unmatched name would silently execute on the default agent and
 * its workspace. Instead the name is validated against the configured agents and
 * applied to `agentId`, and an unknown name is refused so the request fails
 * closed rather than being downgraded to a different agent.
 */
export function resolveAguiAgentRoute(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  callerId: string;
  agentIdHeader: string | undefined;
}): AgentRouteResolution {
  const { runtime, cfg, callerId, agentIdHeader } = params;
  const peer = { kind: "direct" as const, id: callerId };

  const baseRoute = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "ag-ui",
    peer,
  });

  if (agentIdHeader === undefined) {
    return { ok: true, route: baseRoute };
  }

  // Match the canonical gateway header path, which lowercases before comparing
  // (src/gateway/http-utils.ts). `listAgentIds` returns normalized ids, so a
  // merely-trimmed comparison would reject a valid `Auditor` for agent `auditor`.
  const requestedAgentId = agentIdHeader.trim().toLowerCase();
  if (!requestedAgentId || !listAgentIds(cfg).includes(requestedAgentId)) {
    return { ok: false, unknownAgentId: agentIdHeader };
  }
  if (requestedAgentId === baseRoute.agentId) {
    return { ok: true, route: baseRoute };
  }

  // Re-derive the session key for the requested agent so persistence and
  // concurrency scope to it, not to the default agent's key. `mainKey` must be
  // included — canonical routing passes it, and omitting it hands users with a
  // configured session.mainKey a fresh `agent:<id>:main` history instead of
  // their own session.
  const sessionKeyParams = {
    agentId: requestedAgentId,
    channel: "ag-ui",
    accountId: baseRoute.accountId,
    peer,
    ...(cfg.session?.mainKey ? { mainKey: cfg.session.mainKey } : {}),
    ...(baseRoute.dmScope ? { dmScope: baseRoute.dmScope } : {}),
    ...(cfg.session?.identityLinks ? { identityLinks: cfg.session.identityLinks } : {}),
  };
  const sessionKey = runtime.channel.routing.buildAgentSessionKey(sessionKeyParams);
  // `mainSessionKey` is the agent's collapsed main scope, NOT the peer-specific
  // key — deriving it without the peer keeps direct-chat collapse correct.
  const mainSessionKey = runtime.channel.routing.buildAgentSessionKey({
    ...sessionKeyParams,
    peer: null,
  });

  return {
    ok: true,
    route: {
      ...baseRoute,
      agentId: requestedAgentId,
      sessionKey,
      mainSessionKey,
      // baseRoute's policy was derived from the DEFAULT agent's keys, so reusing
      // it here would send last-route updates to the wrong session whenever the
      // two agents disagree on main-vs-session collapse. Re-derive from THIS
      // route's keys with the same canonical rule core uses.
      lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
      // The agent came from an explicit header, so no binding decided it —
      // "default" is this union's value for "no binding matched". Carrying
      // baseRoute's value forward would report a binding that never applied.
      matchedBy: "default",
    },
  };
}
