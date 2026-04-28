/**
 * Public surface of the group sub-package.
 *
 * Grouped here so consumers (bridge-layer wiring, tests, future
 * standalone bootstrap) can reach every group primitive through a
 * single import path without caring about the internal layout.
 */

// Gating — three-layer decision
export {
  resolveGroupMessageGate,
  type GroupMessageGateAction,
  type GroupMessageGateInput,
  type GroupMessageGateResult,
} from "./message-gating.js";

// History buffer — non-@ chatter cache + context formatting
export {
  buildMergedMessageContext,
  buildPendingHistoryContext,
  clearPendingHistory,
  formatAttachmentTags,
  formatMessageContent,
  inferAttachmentType,
  recordPendingHistoryEntry,
  toAttachmentSummaries,
  type AttachmentSummary,
  type FormatMessageContentParams,
  type HistoryEntry,
  type RawAttachment,
} from "./history.js";

// Mention detection / normalization + implicit-mention predicate
export {
  detectWasMentioned,
  hasAnyMention,
  resolveImplicitMention,
  stripMentionText,
  type DetectWasMentionedInput,
  type HasAnyMentionInput,
  type RawMention,
} from "./mention.js";

// Activation mode (session-store override + cfg fallback)
export {
  createNodeSessionStoreReader,
  resolveGroupActivation,
  resolveSessionStorePath,
  type GroupActivationMode,
  type SessionStoreReader,
} from "./activation.js";

// Deliver debouncer — buffers rapid outbound text fragments
export {
  createDeliverDebouncer,
  DeliverDebouncer,
  type DebouncerLogger,
  type DeliverDebounceConfig,
  type DeliverExecutor,
  type DeliverInfo,
  type DeliverPayload,
} from "./deliver-debounce.js";
