/** Channel-level policy for which inbound messages should receive an ack reaction. */
export type AckReactionScope = "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";

/** WhatsApp group-mode policy; direct-message ack reactions are configured separately. */
export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

/** Sent ack reaction state plus the cleanup hook callers can run after reply delivery. */
export type AckReactionHandle = {
  ackReactionPromise: Promise<boolean>;
  ackReactionValue: string;
  remove: () => Promise<void>;
};

/**
 * Inputs for the reusable direct/group/mention gate shared by channel plugins.
 *
 * `effectiveWasMentioned` should already include any channel-specific mention
 * normalization. `shouldBypassMention` is only for an earlier channel gate that
 * proved the active conversation, such as a group activation state.
 */
export type AckReactionGateParams = {
  scope: AckReactionScope | undefined;
  isDirect: boolean;
  isGroup: boolean;
  isMentionableGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention?: boolean;
};

/** Resolves the generic ack reaction gate without sending or removing reactions. */
export function shouldAckReaction(params: AckReactionGateParams): boolean {
  const scope = params.scope ?? "group-mentions";
  if (scope === "off" || scope === "none") {
    return false;
  }
  if (scope === "all") {
    return true;
  }
  if (scope === "direct") {
    return params.isDirect;
  }
  if (scope === "group-all") {
    return params.isGroup;
  }
  if (scope === "group-mentions") {
    if (!params.isMentionableGroup) {
      return false;
    }
    if (!params.requireMention) {
      return false;
    }
    if (!params.canDetectMention) {
      return false;
    }
    // Group activation can stand in for a literal mention when another gate already established
    // that this inbound message belongs to the active conversation.
    return params.effectiveWasMentioned || params.shouldBypassMention === true;
  }
  return false;
}

/** Resolves WhatsApp ack policy while preserving the shared mention-only group gate. */
export function shouldAckReactionForWhatsApp(params: {
  emoji: string;
  isDirect: boolean;
  isGroup: boolean;
  directEnabled: boolean;
  groupMode: WhatsAppAckReactionMode;
  wasMentioned: boolean;
  groupActivated: boolean;
}): boolean {
  if (!params.emoji) {
    return false;
  }
  if (params.isDirect) {
    return params.directEnabled;
  }
  if (!params.isGroup) {
    return false;
  }
  if (params.groupMode === "never") {
    return false;
  }
  if (params.groupMode === "always") {
    return true;
  }
  // WhatsApp "mentions" mode shares the generic group-mentions path so activation bypass and
  // mention detection semantics stay aligned with other channels.
  return shouldAckReaction({
    scope: "group-mentions",
    isDirect: false,
    isGroup: true,
    isMentionableGroup: true,
    requireMention: true,
    canDetectMention: true,
    effectiveWasMentioned: params.wasMentioned,
    shouldBypassMention: params.groupActivated,
  });
}

/** Starts sending an ack reaction and returns the success-tracking cleanup handle. */
export function createAckReactionHandle(params: {
  ackReactionValue: string;
  send: () => Promise<void>;
  remove: () => Promise<void>;
  onSendError?: (err: unknown) => void;
}): AckReactionHandle | null {
  const ackReactionValue = params.ackReactionValue.trim();
  if (!ackReactionValue) {
    return null;
  }

  let sendPromise: Promise<void>;
  try {
    // Send starts eagerly so callers can keep processing while the channel API resolves.
    sendPromise = params.send();
  } catch (err) {
    // Convert sync throws into the same Promise<boolean> flow used for async send failures.
    sendPromise = Promise.reject(toLintErrorObject(err, "Non-Error rejection"));
  }

  return {
    ackReactionPromise: sendPromise.then(
      () => true,
      (err: unknown) => {
        params.onSendError?.(err);
        return false;
      },
    ),
    ackReactionValue,
    remove: params.remove,
  };
}

/** Schedules removal of a previously sent ack reaction after reply delivery. */
export function removeAckReactionAfterReply(params: {
  removeAfterReply: boolean;
  ackReactionPromise: Promise<boolean> | null;
  ackReactionValue: string | null;
  remove: () => Promise<void>;
  onError?: (err: unknown) => void;
}) {
  if (!params.removeAfterReply) {
    return;
  }
  if (!params.ackReactionPromise) {
    return;
  }
  if (!params.ackReactionValue) {
    return;
  }
  // Only remove if the send actually succeeded; failed sends are already reported by the handle.
  void params.ackReactionPromise.then((didAck) => {
    if (!didAck) {
      return;
    }
    params.remove().catch((err: unknown) => params.onError?.(err));
  });
}

/** Convenience wrapper that removes an ack reaction handle after reply delivery. */
export function removeAckReactionHandleAfterReply(params: {
  removeAfterReply: boolean;
  ackReaction: AckReactionHandle | null | undefined;
  onError?: (err: unknown) => void;
}) {
  removeAckReactionAfterReply({
    removeAfterReply: params.removeAfterReply,
    ackReactionPromise: params.ackReaction?.ackReactionPromise ?? null,
    ackReactionValue: params.ackReaction?.ackReactionValue ?? null,
    remove: params.ackReaction?.remove ?? (async () => {}),
    onError: params.onError,
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
