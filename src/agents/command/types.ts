import type { AgentInternalEvent } from "../../agents/internal-events.js";
import type { SpawnedRunMetadata } from "../../agents/spawned-context.js";
import type { PromptMode } from "../../agents/system-prompt.types.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.public.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { AgentStreamParams, ClientToolDefinition } from "./shared-types.js";

/** Image content block for Claude API multimodal messages. */
export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};
export type { AgentStreamParams } from "./shared-types.js";

export type AgentCommandResultMetaOverrides = {
  transport?: "embedded";
  fallbackFrom?: "gateway";
  fallbackReason?: "gateway_timeout";
  fallbackSessionId?: string;
  fallbackSessionKey?: string;
};

export type AcpTurnSource = "manual_spawn";

export type AgentRunContext = {
  messageChannel?: string;
  accountId?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

export type AgentCommandOpts = {
  message: string;
  /** User-visible transcript body; defaults to message and excludes runtime-only context. */
  transcriptMessage?: string;
  /** Optional image attachments for multimodal messages. */
  images?: ImageContent[];
  /** Original inline/offloaded attachment order for inbound images. */
  imageOrder?: PromptImageOrderEntry[];
  /** Optional client-provided tools (OpenResponses hosted tools). */
  clientTools?: ClientToolDefinition[];
  /** Agent id override (must exist in config). */
  agentId?: string;
  /** Per-run provider override. */
  provider?: string;
  /** Per-run model override. */
  model?: string;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  /** Override delivery target (separate from session routing). */
  replyTo?: string;
  /** Override delivery channel (separate from session routing). */
  replyChannel?: string;
  /** Override delivery account id (separate from session routing). */
  replyAccountId?: string;
  /** Override delivery thread/topic id (separate from session routing). */
  threadId?: string | number;
  /** Message channel context. */
  messageChannel?: string;
  /** Delivery channel. */
  channel?: string;
  /** Account ID for multi-account channel routing. */
  accountId?: string;
  /** Context for embedded run routing (channel/account/thread). */
  runContext?: AgentRunContext;
  /** Whether this caller is authorized for owner-only tools (defaults true for local CLI calls). */
  senderIsOwner?: boolean;
  /** Whether this caller is authorized to use provider/model per-run overrides. */
  allowModelOverride?: boolean;
  /** Group/spawn metadata for subagent policy inheritance and routing context. */
  groupId?: SpawnedRunMetadata["groupId"];
  groupChannel?: SpawnedRunMetadata["groupChannel"];
  groupSpace?: SpawnedRunMetadata["groupSpace"];
  spawnedBy?: SpawnedRunMetadata["spawnedBy"];
  deliveryTargetMode?: ChannelOutboundTargetMode;
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  /** Bootstrap workspace context injection mode for this run. */
  bootstrapContextMode?: "full" | "lightweight";
  /** Run kind hint for bootstrap context behavior. */
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  internalEvents?: AgentInternalEvent[];
  inputProvenance?: InputProvenance;
  /** Per-call stream param overrides (best-effort). */
  streamParams?: AgentStreamParams;
  /** Explicit workspace directory override (for subagents to inherit parent workspace). */
  workspaceDir?: SpawnedRunMetadata["workspaceDir"];
  /** Force bundled MCP teardown when a one-shot local run completes. */
  cleanupBundleMcpOnRunEnd?: boolean;
  /** Force long-lived CLI live session teardown when a one-shot local run completes. */
  cleanupCliLiveSessionOnRunEnd?: boolean;
  /** Internal local CLI callers can annotate result metadata before JSON/text output. */
  resultMetaOverrides?: AgentCommandResultMetaOverrides;
  /** Internal one-shot model probe mode: no tools, no workspace/chat prompt policy. */
  modelRun?: boolean;
  /** Internal prompt-mode override for trusted local/gateway callsites. */
  promptMode?: PromptMode;
  /** Internal ACP-ready session turn source. Manual spawn turns bypass only the dispatch gate. */
  acpTurnSource?: AcpTurnSource;
};

export type AgentCommandIngressOpts = Omit<
  AgentCommandOpts,
  "senderIsOwner" | "allowModelOverride" | "resultMetaOverrides"
> & {
  /** Ingress callsites must always pass explicit owner-tool authorization state. */
  senderIsOwner: boolean;
  /** Ingress callsites must always pass explicit model-override authorization state. */
  allowModelOverride: boolean;
};
