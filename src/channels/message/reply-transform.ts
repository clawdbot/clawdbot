// Invokes a public channel reply transform without detaching its messaging receiver.
import {
  copyReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { bindNormalizeReplyTransformOwner } from "../../auto-reply/reply/normalize-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelMessagingAdapter } from "../plugins/types.public.js";

const channelReplyTransformOwners = new WeakMap<object, Map<string, object>>();

function resolveChannelReplyTransformOwner(
  messaging: ChannelMessagingAdapter,
  accountId?: string | null,
): object {
  let owners = channelReplyTransformOwners.get(messaging);
  if (!owners) {
    owners = new Map();
    channelReplyTransformOwners.set(messaging, owners);
  }
  const key = accountId?.trim() ?? "";
  let owner = owners.get(key);
  if (!owner) {
    owner = {};
    owners.set(key, owner);
  }
  return owner;
}

export function bindChannelReplyTransformOwner<
  T extends (payload: ReplyPayload) => ReplyPayload | null,
>(transform: T, messaging: ChannelMessagingAdapter, accountId?: string | null): T {
  return bindNormalizeReplyTransformOwner(
    transform,
    resolveChannelReplyTransformOwner(messaging, accountId),
  );
}

export function createChannelReplyTransform(params: {
  messaging: ChannelMessagingAdapter | undefined;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ((payload: ReplyPayload) => ReplyPayload | null) | undefined {
  if (!params.messaging?.transformReplyPayload) {
    return undefined;
  }
  const transform = (payload: ReplyPayload) => applyChannelReplyTransform({ ...params, payload });
  return bindChannelReplyTransformOwner(transform, params.messaging, params.accountId);
}

export function applyChannelReplyTransform(params: {
  messaging: ChannelMessagingAdapter | undefined;
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ReplyPayload | null {
  const transform = params.messaging?.transformReplyPayload;
  if (!transform || !params.messaging) {
    return params.payload;
  }
  const transformed = transform.call(params.messaging, {
    payload: params.payload,
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return transformed === null
    ? null
    : setReplyPayloadMetadata(copyReplyPayloadMetadata(params.payload, transformed), {
        channelReplyTransformOwner: resolveChannelReplyTransformOwner(
          params.messaging,
          params.accountId,
        ),
      });
}
