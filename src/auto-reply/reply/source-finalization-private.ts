import {
  readCurrentHostChannelContextOwner,
  type HostChannelContextOwner,
} from "../../channels/message-access/admission-evidence.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import {
  hasAutomaticRoomEventFinalCapability,
  type AutomaticRoomEventFinalCapability,
} from "./automatic-room-event-final-capability.js";
import { bindSourceFinalizationPrivateOptions } from "./source-finalization-private-state.js";
import type { SourceFinalizationPrivateOptions } from "./source-finalization.types.js";

export { readSourceFinalizationPrivateOptions } from "./source-finalization-private-state.js";

const MATRIX_SOURCE_FINALIZATION_REQUEST = Symbol.for(
  "openclaw.matrixSourceFinalizationRequest.v1",
);
const MATRIX_CHANNEL_ID = "matrix";

type SourceFinalizationRequest = Readonly<{
  sourceContext: object;
  onBeforeAgentFinalize?: SourceFinalizationPrivateOptions["onBeforeAgentFinalize"];
}>;

type MatrixSourceCleanupCapability = Readonly<{
  isSourceLive: () => boolean;
}>;

type MatrixSourceAcceptedCleanup = (
  capability: MatrixSourceCleanupCapability,
) => Promise<void> | void;

function contextMatchesMatrix(context: object): boolean {
  const channels = ["OriginatingChannel", "Provider", "Surface"]
    .map((key) => ownDataValue(context, key))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return (
    channels.length > 0 && channels.every((value) => value.toLowerCase() === MATRIX_CHANNEL_ID)
  );
}

function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isBundledMatrixOwner(
  owner: HostChannelContextOwner | undefined,
): owner is HostChannelContextOwner {
  return (
    owner?.channelId === MATRIX_CHANNEL_ID &&
    ownDataValue(owner.record, "id") === MATRIX_CHANNEL_ID &&
    ownDataValue(owner.record, "origin") === "bundled" &&
    ownDataValue(owner.record, "status") === "loaded"
  );
}

function extractSourceFinalizationRequest<T extends GetReplyOptions>(
  replyOptions: T,
): {
  replyOptions: T;
  request?: SourceFinalizationRequest;
} {
  const descriptor = Object.getOwnPropertyDescriptor(
    replyOptions,
    MATRIX_SOURCE_FINALIZATION_REQUEST,
  );
  if (!descriptor) {
    return { replyOptions };
  }
  const descriptors = Object.getOwnPropertyDescriptors(replyOptions);
  Reflect.deleteProperty(descriptors, MATRIX_SOURCE_FINALIZATION_REQUEST);
  // SAFETY: Removing only the private symbol descriptor preserves T's public own-property shape.
  const stripped = Object.defineProperties({}, descriptors) as T;
  if (!("value" in descriptor)) {
    return { replyOptions: stripped };
  }
  const sourceContext = ownDataValue(descriptor.value, "sourceContext");
  const onBeforeAgentFinalize = ownDataValue(descriptor.value, "onBeforeAgentFinalize");
  if (
    !sourceContext ||
    typeof sourceContext !== "object" ||
    (onBeforeAgentFinalize !== undefined && typeof onBeforeAgentFinalize !== "function")
  ) {
    return { replyOptions: stripped };
  }
  return {
    replyOptions: stripped,
    request: {
      sourceContext,
      ...(onBeforeAgentFinalize
        ? {
            onBeforeAgentFinalize:
              // SAFETY: The bundled Matrix request producer stores this typed callback; the function guard above preserves it across descriptor extraction.
              onBeforeAgentFinalize as SourceFinalizationPrivateOptions["onBeforeAgentFinalize"],
          }
        : {}),
    },
  };
}

/**
 * Redeems a Matrix source-local request only for its exact live host-owned context.
 * Room events additionally require their automatic-final capability. This is
 * deliberately not a public or cross-channel contract.
 */
export function bindAdmittedMatrixSourceFinalizationRequest<T extends GetReplyOptions>(params: {
  replyOptions: T;
  context: object;
  capability?: AutomaticRoomEventFinalCapability;
}): T {
  const extracted = extractSourceFinalizationRequest(params.replyOptions);
  if (!extracted.request) {
    return extracted.replyOptions;
  }
  const owner = readCurrentHostChannelContextOwner(params.context);
  const inboundEventKind = ownDataValue(params.context, "InboundEventKind");
  const hasRequiredSourceAuthority =
    inboundEventKind === "user_request" ||
    (inboundEventKind === "room_event" &&
      hasAutomaticRoomEventFinalCapability({
        capability: params.capability,
        context: params.context,
      }));
  if (
    extracted.request.sourceContext !== params.context ||
    !isBundledMatrixOwner(owner) ||
    !contextMatchesMatrix(params.context) ||
    !hasRequiredSourceAuthority
  ) {
    throw new Error(
      "Source-final freshness requires automatic delivery; message_tool_only cannot be used for this turn.",
    );
  }
  const ownerRecord = owner.record;
  const isSourceLive = () => {
    const currentOwner = readCurrentHostChannelContextOwner(params.context);
    return currentOwner === owner && currentOwner.record === ownerRecord;
  };
  const cleanupCapability = Object.freeze({ isSourceLive });
  const requestedFinalizer = extracted.request.onBeforeAgentFinalize;
  const onBeforeAgentFinalize = requestedFinalizer
    ? async (event: Parameters<NonNullable<typeof requestedFinalizer>>[0]) => {
        if (!isSourceLive()) {
          return { action: "discard" as const };
        }
        const result = await requestedFinalizer(event);
        if (!isSourceLive()) {
          return { action: "discard" as const };
        }
        if (result.action === "continue" || !result.onAccepted) {
          return result;
        }
        const onAccepted = result.onAccepted;
        return {
          ...result,
          onAccepted: async () => {
            if (isSourceLive()) {
              // SAFETY: The bundled Matrix private request ABI defines accepted cleanup as capability-taking; core wraps it behind a no-argument callback.
              await (onAccepted as MatrixSourceAcceptedCleanup)(cleanupCapability);
            }
          },
        };
      }
    : undefined;
  return bindSourceFinalizationPrivateOptions(extracted.replyOptions, {
    onBeforeAgentFinalize,
    isSourceLive,
    deferSourceMessageToolDelivery: true,
    retainQueuedSourceReplyDelivery: true,
  });
}
