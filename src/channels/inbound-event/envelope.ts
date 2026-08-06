import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
  type AgentEnvelopeParams,
} from "../../auto-reply/envelope.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { readSessionUpdatedAt } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentRoute,
  type ResolvedAgentRoute,
  type ResolveAgentRouteInput,
} from "../../routing/resolve-route.js";

export type ChannelInboundEnvelopeInput = Omit<AgentEnvelopeParams, "previousTimestamp"> & {
  previousTimestamp?: AgentEnvelopeParams["previousTimestamp"] | null;
};

export function createChannelInboundEnvelopeBuilder(params: {
  cfg: OpenClawConfig;
  route: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const envelope = resolveEnvelopeFormatOptions(params.cfg);
  return (input: ChannelInboundEnvelopeInput): string => {
    const previousTimestamp =
      input.previousTimestamp === null
        ? undefined
        : (input.previousTimestamp ??
          readSessionUpdatedAt({ storePath, sessionKey: params.route.sessionKey }));
    return formatAgentEnvelope({
      ...input,
      previousTimestamp,
      envelope: input.envelope ?? envelope,
    });
  };
}

export function resolveChannelInboundRouteEnvelope(params: ResolveAgentRouteInput) {
  const route = resolveAgentRoute(params);
  return {
    route,
    buildEnvelope: createChannelInboundEnvelopeBuilder({ cfg: params.cfg, route }),
  };
}

type RouteLike = {
  agentId: string;
  sessionKey: string;
};

type RoutePeerLike = {
  kind: "direct" | "group" | "channel";
  id: string | number;
};

type InboundEnvelopeFormatParams<TEnvelope> = {
  channel: string;
  from: string;
  timestamp?: number;
  previousTimestamp?: number;
  envelope: TEnvelope;
  body: string;
};

type InboundRouteResolveParams<TConfig, TPeer extends RoutePeerLike> = {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
};

export function createInboundEnvelopeBuilder<TConfig, TEnvelope>(params: {
  cfg: TConfig;
  route: RouteLike;
  sessionStore?: string;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
  formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}) {
  const storePath = params.resolveStorePath(params.sessionStore, {
    agentId: params.route.agentId,
  });
  const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
  return (input: { channel: string; from: string; body: string; timestamp?: number }) => {
    const previousTimestamp = params.readSessionUpdatedAt({
      storePath,
      sessionKey: params.route.sessionKey,
    });
    const body = params.formatAgentEnvelope({
      channel: input.channel,
      from: input.from,
      timestamp: input.timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: input.body,
    });
    return { storePath, body };
  };
}

export function resolveInboundRouteEnvelopeBuilder<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
>(params: {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
  resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
  sessionStore?: string;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
  formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
}): {
  route: TRoute;
  buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
} {
  const route = params.resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const buildEnvelope = createInboundEnvelopeBuilder({
    cfg: params.cfg,
    route,
    sessionStore: params.sessionStore,
    resolveStorePath: params.resolveStorePath,
    readSessionUpdatedAt: params.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: params.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: params.formatAgentEnvelope,
  });
  return { route, buildEnvelope };
}

type InboundRouteEnvelopeRuntime<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
> = {
  routing: {
    resolveAgentRoute: (params: InboundRouteResolveParams<TConfig, TPeer>) => TRoute;
  };
  session: {
    resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
    readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  };
  reply: {
    resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
    formatAgentEnvelope: (params: InboundEnvelopeFormatParams<TEnvelope>) => string;
  };
};

/** Runtime-driven compatibility variant for shipped plugin SDK callers. */
export function resolveInboundRouteEnvelopeBuilderWithRuntime<
  TConfig,
  TEnvelope,
  TRoute extends RouteLike,
  TPeer extends RoutePeerLike,
>(params: {
  cfg: TConfig;
  channel: string;
  accountId: string;
  peer: TPeer;
  runtime: InboundRouteEnvelopeRuntime<TConfig, TEnvelope, TRoute, TPeer>;
  sessionStore?: string;
}): {
  route: TRoute;
  buildEnvelope: ReturnType<typeof createInboundEnvelopeBuilder<TConfig, TEnvelope>>;
} {
  return resolveInboundRouteEnvelopeBuilder({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    resolveAgentRoute: (routeParams) => params.runtime.routing.resolveAgentRoute(routeParams),
    sessionStore: params.sessionStore,
    resolveStorePath: params.runtime.session.resolveStorePath,
    readSessionUpdatedAt: params.runtime.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: params.runtime.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: params.runtime.reply.formatAgentEnvelope,
  });
}
