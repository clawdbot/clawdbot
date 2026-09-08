import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "./server-methods/client-types.js";

export type MentionCommittedInput = {
  sourceId: string;
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  messageId: string;
  senderProfileId: string;
  recipientProfileIds: readonly string[];
  excerpt?: string;
};

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
  ) => Result<UsersMentionableResult, ErrorShape>;
  validateRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Result<readonly string[], ErrorShape>;
  list: (client: GatewayClient | null) => Result<MentionsListResult, ErrorShape>;
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
  ) => Result<MentionsListResult, ErrorShape>;
  recordCommittedInput: (input: MentionCommittedInput) => void;
  invalidate: () => void;
  dispose: () => void;
};
