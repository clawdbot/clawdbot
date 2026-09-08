import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { finalizedContextScopeKey, ownDataValue } from "./admission-evidence-scope-key.js";
import { readChannelIngressHostOwner, type ChannelIngressHostOwner } from "./ingress-host-owner.js";

/** Verified source facts; administrator policy and run lifetime belong to the caller. */
export type AuthenticatedChannelAdministratorSource = Readonly<{
  channel: string;
  accountId: string;
  senderId: string;
  conversationId: string;
  assertActive: () => void;
}>;

type AuthenticatedNativeHumanSource = {
  source: Omit<AuthenticatedChannelAdministratorSource, "assertActive">;
  owner: ChannelIngressHostOwner;
  ownerEpoch: object;
  consumed: boolean;
};

type AuthenticatedNativeHumanContext = {
  source: AuthenticatedNativeHumanSource;
  originalContext: object;
  scopeKey: string;
};

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.authenticatedChannelAdministratorSourceState"),
  () => ({
    sourceByPreparation: new WeakMap<object, AuthenticatedNativeHumanSource>(),
    sourceByContext: new WeakMap<object, AuthenticatedNativeHumanContext>(),
    conflictsByContext: new WeakSet<object>(),
  }),
);

/** Host ingress calls this only after validating the complete resolver handoff. */
export function prepareAuthenticatedChannelAdministratorSource(params: {
  preparation: object;
  source: Omit<AuthenticatedChannelAdministratorSource, "assertActive">;
  owner: ChannelIngressHostOwner;
}): void {
  // This private carrier is always on, independent of diagnostic collection.
  state.sourceByPreparation.set(params.preparation, {
    source: Object.freeze({ ...params.source }),
    owner: params.owner,
    ownerEpoch: params.owner.epoch,
    consumed: false,
  });
}

/** Bind the one-shot prepared source to its exact finalized context scope. */
export function bindAuthenticatedChannelAdministratorSource(params: {
  preparation: object;
  context: object;
  scopeKey: string | undefined;
}): void {
  const source = state.sourceByPreparation.get(params.preparation);
  state.sourceByPreparation.delete(params.preparation);
  if (source && params.scopeKey !== undefined) {
    state.sourceByContext.set(params.context, {
      source,
      originalContext: params.context,
      scopeKey: params.scopeKey,
    });
  }
}

function isNativeHumanContextActive(
  binding: AuthenticatedNativeHumanContext,
  context: object,
): boolean {
  const { source, originalContext, scopeKey } = binding;
  try {
    return (
      readChannelIngressHostOwner(source.source.channel) === source.owner &&
      source.owner.epoch === source.ownerEpoch &&
      source.owner.isLive() &&
      finalizedContextScopeKey(originalContext) === scopeKey &&
      finalizedContextScopeKey(context) === scopeKey &&
      ownDataValue(originalContext, "SenderIsBot") !== true &&
      ownDataValue(context, "SenderIsBot") !== true
    );
  } catch {
    return false;
  }
}

/** Consume one authentic native-human handoff; route fields alone never mint this source. */
export function consumeAuthenticatedChannelAdministratorSource(
  context: object,
): AuthenticatedChannelAdministratorSource | undefined {
  const binding = state.sourceByContext.get(context);
  if (!binding || binding.source.consumed || !isNativeHumanContextActive(binding, context)) {
    return undefined;
  }
  binding.source.consumed = true;
  return Object.freeze({
    ...binding.source.source,
    assertActive: () => {
      if (!isNativeHumanContextActive(binding, context)) {
        throw new Error("authenticated channel administrator source is no longer active");
      }
    },
  });
}

/** Preserve owner-initiated context copies; report whether a source carrier existed. */
export function copyAuthenticatedChannelAdministratorSource(
  source: object,
  target: object,
): boolean {
  const nativeHumanSource = state.sourceByContext.get(source);
  if (!nativeHumanSource) {
    return false;
  }
  if (
    !nativeHumanSource.source.consumed &&
    isNativeHumanContextActive(nativeHumanSource, source) &&
    isNativeHumanContextActive(nativeHumanSource, target)
  ) {
    const current = state.sourceByContext.get(target);
    if (current && current.source !== nativeHumanSource.source) {
      state.sourceByContext.delete(target);
      state.conflictsByContext.add(target);
    } else if (!state.conflictsByContext.has(target)) {
      state.sourceByContext.set(target, nativeHumanSource);
    }
  }
  return true;
}
