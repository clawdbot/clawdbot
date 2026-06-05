/**
 * Channel message adapter contract verification helpers.
 *
 * Runs proof callbacks for declared durable, live-preview, live-message, and receive capabilities.
 */
import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveCapability,
  ChannelMessageReceiveAckPolicy,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryRequirementMap,
  LivePreviewFinalizerCapability,
  LivePreviewFinalizerCapabilityMap,
} from "./types.js";
import {
  channelMessageLiveCapabilities,
  channelMessageReceiveAckPolicies,
  durableFinalDeliveryCapabilities,
  livePreviewFinalizerCapabilities,
} from "./types.js";

/**
 * Proof callback used to verify one declared durable-final delivery capability.
 */
export type DurableFinalCapabilityProof = () => Promise<void> | void;

/**
 * Proof callbacks keyed by durable-final delivery capability.
 */
export type DurableFinalCapabilityProofMap = Partial<
  Record<DurableFinalDeliveryCapability, DurableFinalCapabilityProof>
>;

/**
 * Verification result for one durable-final delivery capability.
 */
export type DurableFinalCapabilityProofResult = {
  capability: DurableFinalDeliveryCapability;
  status: "verified" | "not_declared";
};

/**
 * Proof callback used to verify one live-preview finalizer capability.
 */
export type LivePreviewFinalizerCapabilityProof = () => Promise<void> | void;

/**
 * Proof callback used to verify one live message capability.
 */
export type ChannelMessageLiveCapabilityProof = () => Promise<void> | void;

/**
 * Proof callback used to verify one receive acknowledgement policy.
 */
export type ChannelMessageReceiveAckPolicyProof = () => Promise<void> | void;

/**
 * Proof callbacks keyed by live-preview finalizer capability.
 */
export type LivePreviewFinalizerCapabilityProofMap = Partial<
  Record<LivePreviewFinalizerCapability, LivePreviewFinalizerCapabilityProof>
>;

/**
 * Proof callbacks keyed by live message capability.
 */
export type ChannelMessageLiveCapabilityProofMap = Partial<
  Record<ChannelMessageLiveCapability, ChannelMessageLiveCapabilityProof>
>;

/**
 * Proof callbacks keyed by receive acknowledgement policy.
 */
export type ChannelMessageReceiveAckPolicyProofMap = Partial<
  Record<ChannelMessageReceiveAckPolicy, ChannelMessageReceiveAckPolicyProof>
>;

/**
 * Verification result for one live-preview finalizer capability.
 */
export type LivePreviewFinalizerCapabilityProofResult = {
  capability: LivePreviewFinalizerCapability;
  status: "verified" | "not_declared";
};

/**
 * Verification result for one live message capability.
 */
export type ChannelMessageLiveCapabilityProofResult = {
  capability: ChannelMessageLiveCapability;
  status: "verified" | "not_declared";
};

/**
 * Verification result for one receive acknowledgement policy.
 */
export type ChannelMessageReceiveAckPolicyProofResult = {
  policy: ChannelMessageReceiveAckPolicy;
  status: "verified" | "not_declared";
};

/**
 * Lists declared durable-final delivery capabilities in stable contract order.
 */
export function listDeclaredDurableFinalCapabilities(
  capabilities: DurableFinalDeliveryRequirementMap | undefined,
): DurableFinalDeliveryCapability[] {
  return durableFinalDeliveryCapabilities.filter(
    (capability) => capabilities?.[capability] === true,
  );
}

/**
 * Lists declared live-preview finalizer capabilities in stable contract order.
 */
export function listDeclaredLivePreviewFinalizerCapabilities(
  capabilities: LivePreviewFinalizerCapabilityMap | undefined,
): LivePreviewFinalizerCapability[] {
  return livePreviewFinalizerCapabilities.filter(
    (capability) => capabilities?.[capability] === true,
  );
}

/**
 * Lists declared live message capabilities in stable contract order.
 */
export function listDeclaredChannelMessageLiveCapabilities(
  capabilities: Partial<Record<ChannelMessageLiveCapability, boolean>> | undefined,
): ChannelMessageLiveCapability[] {
  return channelMessageLiveCapabilities.filter((capability) => capabilities?.[capability] === true);
}

/**
 * Lists declared receive acknowledgement policies, including the default policy fallback.
 */
export function listDeclaredReceiveAckPolicies(
  receive: ChannelMessageAdapterShape["receive"] | undefined,
): ChannelMessageReceiveAckPolicy[] {
  const declared = receive?.supportedAckPolicies?.length
    ? receive.supportedAckPolicies
    : receive?.defaultAckPolicy
      ? [receive.defaultAckPolicy]
      : [];
  return channelMessageReceiveAckPolicies.filter((policy) => declared.includes(policy));
}

/**
 * Verifies proof callbacks for every declared durable-final delivery capability.
 */
export async function verifyDurableFinalCapabilityProofs(params: {
  adapterName: string;
  capabilities?: DurableFinalDeliveryRequirementMap;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]> {
  const results: DurableFinalCapabilityProofResult[] = [];
  for (const capability of durableFinalDeliveryCapabilities) {
    // Iterate over the canonical capability list so missing declarations still produce
    // not_declared records and result ordering stays stable for tests and reports.
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares durable final capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/**
 * Verifies proof callbacks for every declared live-preview finalizer capability.
 */
export async function verifyLivePreviewFinalizerCapabilityProofs(params: {
  adapterName: string;
  capabilities?: LivePreviewFinalizerCapabilityMap;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]> {
  const results: LivePreviewFinalizerCapabilityProofResult[] = [];
  for (const capability of livePreviewFinalizerCapabilities) {
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares live preview finalizer capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/**
 * Verifies proof callbacks for every declared live message capability.
 */
export async function verifyChannelMessageLiveCapabilityProofs(params: {
  adapterName: string;
  capabilities?: Partial<Record<ChannelMessageLiveCapability, boolean>>;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]> {
  const results: ChannelMessageLiveCapabilityProofResult[] = [];
  for (const capability of channelMessageLiveCapabilities) {
    if (params.capabilities?.[capability] !== true) {
      results.push({ capability, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[capability];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares live capability "${capability}" without a contract proof`,
      );
    }
    await proof();
    results.push({ capability, status: "verified" });
  }
  return results;
}

/**
 * Verifies proof callbacks for every declared receive acknowledgement policy.
 */
export async function verifyChannelMessageReceiveAckPolicyProofs(params: {
  adapterName: string;
  receive?: ChannelMessageAdapterShape["receive"];
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]> {
  const declared = new Set(listDeclaredReceiveAckPolicies(params.receive));
  const results: ChannelMessageReceiveAckPolicyProofResult[] = [];
  for (const policy of channelMessageReceiveAckPolicies) {
    if (!declared.has(policy)) {
      results.push({ policy, status: "not_declared" });
      continue;
    }
    const proof = params.proofs[policy];
    if (!proof) {
      throw new Error(
        `${params.adapterName} declares receive ack policy "${policy}" without a contract proof`,
      );
    }
    await proof();
    results.push({ policy, status: "verified" });
  }
  return results;
}

/**
 * Verifies durable-final proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageAdapterCapabilityProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "durableFinal">;
  proofs: DurableFinalCapabilityProofMap;
}): Promise<DurableFinalCapabilityProofResult[]> {
  return await verifyDurableFinalCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.durableFinal?.capabilities,
    proofs: params.proofs,
  });
}

/**
 * Verifies receive acknowledgement proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageReceiveAckPolicyAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "receive">;
  proofs: ChannelMessageReceiveAckPolicyProofMap;
}): Promise<ChannelMessageReceiveAckPolicyProofResult[]> {
  return await verifyChannelMessageReceiveAckPolicyProofs({
    adapterName: params.adapterName,
    receive: params.adapter.receive,
    proofs: params.proofs,
  });
}

/**
 * Verifies live-preview finalizer proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageLiveFinalizerProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: LivePreviewFinalizerCapabilityProofMap;
}): Promise<LivePreviewFinalizerCapabilityProofResult[]> {
  return await verifyLivePreviewFinalizerCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.live?.finalizer?.capabilities,
    proofs: params.proofs,
  });
}

/**
 * Verifies live message capability proofs from a channel message adapter declaration.
 */
export async function verifyChannelMessageLiveCapabilityAdapterProofs(params: {
  adapterName: string;
  adapter: Pick<ChannelMessageAdapterShape, "live">;
  proofs: ChannelMessageLiveCapabilityProofMap;
}): Promise<ChannelMessageLiveCapabilityProofResult[]> {
  return await verifyChannelMessageLiveCapabilityProofs({
    adapterName: params.adapterName,
    capabilities: params.adapter.live?.capabilities,
    proofs: params.proofs,
  });
}
