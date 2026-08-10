// Session-stable source-reply mode for synthetic turns (heartbeat wakes,
// system events, inter-session announcements) that reach the reply resolver
// without dispatch's injected delivery-mode facts.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode.js";

/**
 * Resolves the session's stable source-reply mode from persisted session facts.
 * Synthetic turns keep their effective delivery mode, but CLI session reuse
 * belongs to the existing session's normal source-reply policy — every turn
 * kind on a session must derive the same messageToolPolicyHash, or chat and
 * heartbeat turns ping-pong the CLI binding on each transition (#121485).
 */
export function resolveSessionStableReplyMode(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  defaultProvider: string;
  defaultModel: string;
  inputProvenance?: InputProvenance;
}): SourceReplyDeliveryMode {
  const { cfg, sessionEntry } = params;
  const stableReplyContext = {
    CommandAuthorized: false,
    ChatType: sessionEntry.chatType,
    Provider: sessionDeliveryOrigin(sessionEntry)?.provider,
    Surface: sessionDeliveryChannel(sessionEntry),
    InputProvenance: params.inputProvenance,
  };
  const stableProvider =
    normalizeOptionalString(sessionEntry.modelProvider) ?? params.defaultProvider;
  const stableModel = normalizeOptionalString(sessionEntry.model) ?? params.defaultModel;
  // Harness defaults are advisory here, as in dispatch's visible-reply default
  // resolution; a lookup failure must not fail the turn, config still decides.
  let defaultVisibleReplies: "automatic" | "message_tool" | undefined;
  try {
    const stableRuntime = resolveEffectiveAgentRuntime({
      cfg,
      provider: stableProvider,
      modelId: stableModel,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
      sessionEntry,
    });
    const harness = selectAgentHarness({
      provider: stableProvider,
      modelId: stableModel,
      config: cfg,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
      agentHarnessRuntimeOverride: stableRuntime,
    });
    defaultVisibleReplies =
      harness.deliveryDefaults?.visibleReplies ?? harness.deliveryDefaults?.sourceVisibleReplies;
  } catch (error) {
    logVerbose(
      `session-stable reply mode: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
  }
  return resolveSourceReplyDeliveryMode({
    cfg,
    ctx: stableReplyContext,
    defaultVisibleReplies,
  });
}
