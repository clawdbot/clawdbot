// Shared channel session recording contracts for inbound dispatch and metadata writers.
import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import type { ChannelRouteRef } from "../plugin-sdk/channel-route.js";

export type InboundLastRouteUpdate = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  mainDmOwnerPin?: {
    ownerRecipient: string;
    senderRecipient: string;
    onSkip?: (params: { ownerRecipient: string; senderRecipient: string }) => void;
  };
};

/** Function contract for recording inbound channel session state. */
export type RecordInboundSession = (params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}) => Promise<void>;
