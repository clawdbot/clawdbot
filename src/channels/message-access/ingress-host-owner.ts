import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export type ChannelIngressHostOwner = Readonly<{
  channelId: string;
  record: object;
  epoch: object;
  isLive: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}>;

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.channelIngressHostOwners"),
  () => new Map<string, ChannelIngressHostOwner>(),
);

/** Register one exact native channel record as the current in-process producer. */
export function registerChannelIngressHostOwner(owner: ChannelIngressHostOwner): () => void {
  owners.set(owner.channelId, owner);
  return () => {
    if (owners.get(owner.channelId) === owner) {
      owners.delete(owner.channelId);
    }
  };
}

/** Host lifecycle ownership is independent of diagnostic collection and contains no identity facts. */
export function readChannelIngressHostOwner(
  channelId: string,
): ChannelIngressHostOwner | undefined {
  return owners.get(channelId);
}
