import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { parseSlackTarget, type SlackTargetKind } from "./targets.js";

type SlackRouteBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type SlackRouteBindingPeer = NonNullable<SlackRouteBinding["match"]["peer"]>;

const slackRouteBindingConfigCache = new WeakMap<
  OpenClawConfig,
  { bindingsRef: OpenClawConfig["bindings"]; normalizedCfg: OpenClawConfig }
>();

function slackTargetDefaultKindForPeer(kind: SlackRouteBindingPeer["kind"]): SlackTargetKind {
  return kind === "direct" ? "user" : "channel";
}

function slackTargetKindMatchesPeer(
  peerKind: SlackRouteBindingPeer["kind"],
  targetKind: SlackTargetKind,
): boolean {
  if (targetKind === "user") {
    return peerKind === "direct";
  }
  return peerKind === "channel" || peerKind === "group";
}

function normalizeSlackRouteBindingPeer(peer: SlackRouteBindingPeer): SlackRouteBindingPeer {
  const rawId = peer.id.trim();
  if (!rawId || rawId === "*") {
    return peer;
  }

  const target = (() => {
    try {
      return parseSlackTarget(rawId, {
        defaultKind: slackTargetDefaultKindForPeer(peer.kind),
      });
    } catch {
      return undefined;
    }
  })();
  if (!target || !slackTargetKindMatchesPeer(peer.kind, target.kind)) {
    return peer;
  }
  const normalizedId = target.teamId
    ? `team:${target.teamId}:${target.kind}:${target.id}`
    : target.id;
  return normalizedId === peer.id ? peer : { ...peer, id: normalizedId };
}

export function normalizeSlackRouteBindingConfig(cfg: OpenClawConfig): OpenClawConfig {
  const bindings = cfg.bindings;
  const cached = slackRouteBindingConfigCache.get(cfg);
  if (cached && cached.bindingsRef === bindings) {
    return cached.normalizedCfg;
  }
  if (!Array.isArray(bindings)) {
    return cfg;
  }

  let changed = false;
  const normalizedBindings: NonNullable<OpenClawConfig["bindings"]> = bindings.map((binding) => {
    if (binding.type === "acp" || binding.match.channel.trim().toLowerCase() !== "slack") {
      return binding;
    }
    const peer = binding.match.peer;
    if (!peer) {
      return binding;
    }
    const normalizedPeer = normalizeSlackRouteBindingPeer(peer);
    if (normalizedPeer === peer) {
      return binding;
    }
    changed = true;
    return {
      ...binding,
      match: {
        ...binding.match,
        peer: normalizedPeer,
      },
    };
  });

  const normalizedCfg: OpenClawConfig = changed ? { ...cfg, bindings: normalizedBindings } : cfg;
  slackRouteBindingConfigCache.set(cfg, { bindingsRef: bindings, normalizedCfg });
  return normalizedCfg;
}

export function resolveSlackConversationBindingRoute(params: {
  cfg: OpenClawConfig;
  route: ReturnType<typeof resolveAgentRoute>;
  accountId: string;
  baseConversationId: string;
  runtimeBindingThreadId?: string;
  bindingsEnabled: boolean;
  touchBinding?: boolean;
}) {
  const boundThreadRoute =
    params.bindingsEnabled && params.runtimeBindingThreadId
      ? resolveRuntimeConversationBindingRoute({
          route: params.route,
          touchBinding: params.touchBinding,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: params.runtimeBindingThreadId,
            parentConversationId: params.baseConversationId,
          },
        })
      : null;
  const runtimeRoute: RuntimeConversationBindingRouteResult = !params.bindingsEnabled
    ? {
        bindingOwnerAvailable: true,
        route: params.route,
        bindingRecord: null,
        boundSessionKey: undefined,
      }
    : boundThreadRoute?.boundSessionKey || boundThreadRoute?.bindingRecord
      ? boundThreadRoute
      : resolveRuntimeConversationBindingRoute({
          route: params.route,
          touchBinding: params.touchBinding,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: params.baseConversationId,
          },
        });
  const configuredRoute =
    params.bindingsEnabled && !runtimeRoute.boundSessionKey && !runtimeRoute.bindingRecord
      ? resolveConfiguredBindingRoute({
          cfg: params.cfg,
          route: params.route,
          conversation: {
            channel: "slack",
            accountId: params.accountId,
            conversationId: params.baseConversationId,
          },
        })
      : null;
  return {
    runtimeRoute,
    configuredRoute,
    route: runtimeRoute.boundSessionKey
      ? runtimeRoute.route
      : (configuredRoute?.route ?? params.route),
  };
}
