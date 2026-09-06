import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob, CronResolvedDeliveryState, CronRunTelemetry } from "../types.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

export type SuccessfulCronDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

export type DispatchCronDeliveryParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  sourceSessionKey?: string;
  sourceSessionGeneration?: { sessionId: string; lifecycleRevision: string | undefined };
  runSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionUpdatedAt: number;
  beforeSessionDelete?: () => void;
  runStartedAt: number;
  runEndedAt: number;
  timeoutMs: number;
  resolvedDelivery: DeliveryTargetResolution;
  /** Preserve prepared intent instead of rereading job configuration after inference. */
  deliveryPlan: CronDeliveryPlan;
  deliveryRequested: boolean;
  /** Finalizer-owned execution status if delivery cannot recover a presentation warning. */
  undeliveredRunStatus: "ok" | "error";
  skipDelivery?: NormalizeReplySkipReason;
  spawnOnlyHandoff: boolean;
  sourceDeliveryOutcome: SourceDeliveryOutcome;
  /** Queues same-source fallback awareness only after a durable completion commit fails. */
  queueSourceSessionMessageToolAwareness?: () => Promise<void>;
  deliveryBestEffort: boolean;
  deliveryPayloadHasStructuredContent: boolean;
  deliveryPayloads: ReplyPayload[];
  synthesizedText?: string;
  ttsAuto?: TtsAutoMode;
  summary?: string;
  outputText?: string;
  telemetry?: CronRunTelemetry;
  abortSignal?: AbortSignal;
  isAborted: () => boolean;
  abortReason: () => string;
  withRunSession: (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ) => RunCronAgentTurnResult;
};

/** Mutable delivery-dispatch accumulator returned to the isolated cron runner. */
export type DispatchCronDeliveryState = {
  result?: RunCronAgentTurnResult;
  deliveryState: CronResolvedDeliveryState;
  delivered?: boolean;
  deliveryAttempted: boolean;
  deliveryError?: string;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayloads: ReplyPayload[];
};
