/**
 * High-level runtime resolver for inbound channel access decisions.
 *
 * Channel plugins should use this subpath for new receive paths. It accepts
 * platform facts, raw allowlists, route descriptors, command facts, and access
 * group config, then returns sender/route/command/activation projections plus
 * the ordered ingress graph.
 */
export {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  readChannelIngressStoreAllowFromForDmPolicy,
  resolveChannelMessageIngress,
  resolveStableChannelMessageIngress,
} from "../channels/message-access/index.js";
export { resolveChannelImplicitMentions } from "../config/implicit-mentions.js";
export type {
  AccessGroupMembershipFact,
  ChannelIngressDecision,
  ChannelIngressAccessGroupMembershipResolver,
  ChannelIngressCommandPresetInput,
  ChannelIngressConfigInput,
  ChannelIngressEventInput,
  ChannelIngressEventPresetInput,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityAlias,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ChannelIngressResolver,
  ChannelIngressResolverMessageParams,
  ChannelIngressStateInput,
  ChannelIngressState,
  ChannelMessageIngressCommandInput,
  CreateChannelIngressResolverParams,
  IngressReasonCode,
  ResolvedChannelMessageIngress,
  ResolveChannelMessageIngressParams,
  ResolveStableChannelMessageIngressParams,
  StableChannelIngressIdentityParams,
} from "../channels/message-access/index.js";
export type { ResolvedChannelImplicitMentions } from "../config/implicit-mentions.js";

import type { ChannelIngressMonitorLifecycle } from "../channels/message/ingress-monitor.js";

type ChannelIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

/** Fan one logical inbound turn's ownership lifecycle across its durable claims. */
export function fanInChannelIngressLifecycles(
  inputs: readonly (ChannelIngressLifecycle | undefined)[],
): {
  lifecycle: ChannelIngressLifecycle | undefined;
  settle: () => Promise<void>;
  abandon: (error?: unknown) => Promise<void>;
} {
  const lifecycles = inputs.filter((lifecycle) => lifecycle !== undefined);
  const first = lifecycles[0];
  if (!first) {
    return { lifecycle: undefined, settle: async () => {}, abandon: async () => {} };
  }

  let handedOff = false;
  const adoptAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAdopted();
    }
  };
  const abandonAll = async () => {
    await Promise.all(lifecycles.map(async (lifecycle) => await lifecycle.onAbandoned()));
  };
  const failAll = async (error: unknown) => {
    await Promise.all(lifecycles.map(async (lifecycle) => await lifecycle.onFailed?.(error)));
  };

  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? first.abortSignal
          : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
      onAdopted: async () => {
        handedOff = true;
        await adoptAll();
      },
      onDeferred: () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          lifecycle.onDeferred();
        }
      },
      onAdoptionFinalizing: () => {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
      },
      onFailed: async (error) => {
        handedOff = true;
        await failAll(error);
      },
      onAbandoned: async () => {
        handedOff = true;
        await abandonAll();
      },
    },
    // A gated or deliberately skipped turn still consumed every source claim.
    settle: async () => {
      if (!handedOff) {
        await adoptAll();
        handedOff = true;
      }
    },
    abandon: async (_error?: unknown) => {
      if (!handedOff) {
        handedOff = true;
        await abandonAll();
      }
    },
  };
}
