import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { SourceFinalizationPrivateOptions } from "./source-finalization.types.js";

const SOURCE_FINALIZATION_PRIVATE_CARRIER = Symbol.for("openclaw.sourceFinalizationPrivateCarrier");
const SOURCE_FINALIZATION_PRIVATE_STATE = Symbol.for("openclaw.sourceFinalizationPrivateState");

const sourceFinalizationPrivateState = resolveGlobalSingleton(
  SOURCE_FINALIZATION_PRIVATE_STATE,
  () => new WeakMap<object, SourceFinalizationPrivateOptions>(),
);

/** Binds ephemeral source-owned policy without widening the public reply-options shape. */
export function bindSourceFinalizationPrivateOptions<T extends GetReplyOptions>(
  replyOptions: T,
  privateOptions: SourceFinalizationPrivateOptions,
): T {
  const token = {};
  sourceFinalizationPrivateState.set(token, privateOptions);
  const bound = { ...replyOptions };
  Object.defineProperty(bound, SOURCE_FINALIZATION_PRIVATE_CARRIER, {
    configurable: false,
    enumerable: true,
    value: token,
    writable: false,
  });
  return bound;
}

/** Resolves only tokens minted by the private host runtime. */
export function readSourceFinalizationPrivateOptions(
  replyOptions: unknown,
): SourceFinalizationPrivateOptions | undefined {
  if (!replyOptions || typeof replyOptions !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    replyOptions,
    SOURCE_FINALIZATION_PRIVATE_CARRIER,
  );
  if (!descriptor || !("value" in descriptor)) {
    return undefined;
  }
  const token = descriptor.value;
  return token && typeof token === "object" ? sourceFinalizationPrivateState.get(token) : undefined;
}
