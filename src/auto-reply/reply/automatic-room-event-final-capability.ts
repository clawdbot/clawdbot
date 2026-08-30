import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  finalizedContextScopeKey,
  ownDataValue,
} from "../../channels/message-access/admission-evidence-scope-key.js";
import {
  hasCurrentHostChannelContextOwner,
  readCurrentHostChannelContextOwner,
  type HostChannelContextOwner,
} from "../../channels/message-access/admission-evidence.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { QueuedSourceReplyDelivery } from "./source-finalization.types.js";

declare const automaticRoomEventFinalCapabilityBrand: unique symbol;

/** Opaque core-only authority for one admitted automatic external room-event final. */
export type AutomaticRoomEventFinalCapability = Readonly<{
  [automaticRoomEventFinalCapabilityBrand]: true;
}>;

type AdmittedSourceBinding = Readonly<{
  context: object;
  scopeKey: string;
  messageId: string;
  owner: HostChannelContextOwner;
}>;

type CapabilityBinding = Readonly<{
  source: AdmittedSourceBinding;
  context: object;
  scopeKey: string;
}>;

const AUTOMATIC_ROOM_EVENT_FINAL_CAPABILITY_STATE_KEY = Symbol.for(
  "openclaw.automaticRoomEventFinalCapabilityState",
);
const state = resolveGlobalSingleton(AUTOMATIC_ROOM_EVENT_FINAL_CAPABILITY_STATE_KEY, () => ({
  sourceBindingByContext: new WeakMap<object, AdmittedSourceBinding>(),
  bindingByCapability: new WeakMap<object, CapabilityBinding>(),
  sourceBindingByQueuedDelivery: new WeakMap<object, AdmittedSourceBinding>(),
}));

function ownOptionalString(context: object, key: PropertyKey): string | undefined {
  return normalizeOptionalString(ownDataValue(context, key));
}

function contextMatchesMessageId(context: object, messageId: string): boolean {
  return ["MessageSidFull", "MessageSid", "MessageSidFirst", "MessageSidLast"].some(
    (key) => ownOptionalString(context, key) === messageId,
  );
}

function contextMatchesChannel(context: object, channelId: string): boolean {
  const channels = ["OriginatingChannel", "Provider", "Surface"]
    .map((key) => ownOptionalString(context, key)?.toLowerCase())
    .filter((value): value is string => value !== undefined);
  return channels.length > 0 && channels.every((value) => value === channelId.toLowerCase());
}

function isCurrentSourceBinding(binding: AdmittedSourceBinding): boolean {
  return (
    binding.owner.isLive() &&
    hasCurrentHostChannelContextOwner(binding.context, binding.owner) &&
    finalizedContextScopeKey(binding.context) === binding.scopeKey &&
    contextMatchesMessageId(binding.context, binding.messageId)
  );
}

function createCapability(
  source: AdmittedSourceBinding,
  context: object,
): AutomaticRoomEventFinalCapability | undefined {
  if (!isCurrentSourceBinding(source)) {
    return undefined;
  }
  const scopeKey = finalizedContextScopeKey(context);
  if (scopeKey === undefined) {
    return undefined;
  }
  // SAFETY: This module is the sole minter; WeakMap identity binding, not the erased brand, authorizes use.
  const capability = Object.freeze({}) as AutomaticRoomEventFinalCapability;
  state.bindingByCapability.set(capability, Object.freeze({ source, context, scopeKey }));
  return capability;
}

/** Bind one exact room-event context only when its bundled owner reaches core dispatch. */
export function bindAdmittedRoomEventSourceDelivery(params: {
  context: object;
  channelId: string;
  accountId?: string;
  messageId?: string;
}): void {
  const messageId = normalizeOptionalString(params.messageId);
  const scopeKey = finalizedContextScopeKey(params.context);
  const owner = readCurrentHostChannelContextOwner(params.context);
  if (
    !messageId ||
    !scopeKey ||
    owner?.channelId !== params.channelId ||
    ownDataValue(params.context, "InboundEventKind") !== "room_event" ||
    !contextMatchesChannel(params.context, params.channelId) ||
    !contextMatchesMessageId(params.context, messageId)
  ) {
    return;
  }
  const contextAccountId = ownOptionalString(params.context, "AccountId");
  const expectedAccountId = normalizeOptionalString(params.accountId);
  if (expectedAccountId !== undefined && contextAccountId !== expectedAccountId) {
    return;
  }
  state.sourceBindingByContext.set(
    params.context,
    Object.freeze({ context: params.context, scopeKey, messageId, owner }),
  );
}

/** Mint an opaque capability from the exact live context admitted by the host. */
export function mintAutomaticRoomEventFinalCapability(
  context: object,
): AutomaticRoomEventFinalCapability | undefined {
  const source = state.sourceBindingByContext.get(context);
  state.sourceBindingByContext.delete(context);
  return source ? createCapability(source, context) : undefined;
}

/** Validate a capability against both its exact consumer context and live source owner. */
export function hasAutomaticRoomEventFinalCapability(params: {
  capability?: AutomaticRoomEventFinalCapability;
  context: object;
}): boolean {
  if (!params.capability) {
    return false;
  }
  const binding = state.bindingByCapability.get(params.capability);
  return (
    binding !== undefined &&
    binding.context === params.context &&
    finalizedContextScopeKey(params.context) === binding.scopeKey &&
    isCurrentSourceBinding(binding.source)
  );
}

/** Register the exact retained queue owner; structural copies receive no authority. */
export function bindQueuedSourceReplyDeliveryCapability(params: {
  queued: QueuedSourceReplyDelivery;
  capability?: AutomaticRoomEventFinalCapability;
  context: object;
}): void {
  if (
    !params.capability ||
    !hasAutomaticRoomEventFinalCapability({
      capability: params.capability,
      context: params.context,
    })
  ) {
    return;
  }
  const binding = state.bindingByCapability.get(params.capability);
  if (binding) {
    state.sourceBindingByQueuedDelivery.set(params.queued, binding.source);
  }
}

/** True only for the exact retained queue owner while its bundled source owner remains live. */
export function hasQueuedSourceReplyDeliveryCapability(
  queued: QueuedSourceReplyDelivery | undefined,
): boolean {
  if (!queued) {
    return false;
  }
  const source = state.sourceBindingByQueuedDelivery.get(queued);
  return source !== undefined && isCurrentSourceBinding(source);
}

/** Mint a context-bound policy capability from one exact authorized queued owner. */
export function mintQueuedAutomaticRoomEventFinalCapability(params: {
  queued: QueuedSourceReplyDelivery | undefined;
  context: object;
}): AutomaticRoomEventFinalCapability | undefined {
  const source = params.queued ? state.sourceBindingByQueuedDelivery.get(params.queued) : undefined;
  return source ? createCapability(source, params.context) : undefined;
}
