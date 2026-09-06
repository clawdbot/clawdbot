import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  isHeartbeatContentEffectivelyEmpty,
} from "../auto-reply/heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readHeartbeatMonitorScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { formatErrorMessage } from "./errors.js";
import {
  isCronSystemEvent,
  isExecCompletionEvent,
  isHeartbeatDeliveryAwarenessEvent,
  isHeartbeatNoiseEvent,
  isRelayableExecCompletionEvent,
  resolveHeartbeatEventPrompt,
} from "./heartbeat-events-filter.js";
import {
  heartbeatLog,
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatResponseToolPrompt,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import { resolveHeartbeatSessionSelection } from "./heartbeat-runner-session.js";
import {
  resolveHeartbeatWakePayloadFlags,
  type HeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import { selectAgentSystemEvents } from "./system-event-ownership.js";
import {
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

const log = heartbeatLog;

export function truncateHeartbeatPreview(value: string | undefined): string | undefined {
  return value ? truncateUtf16Safe(value, 200) : undefined;
}

type HeartbeatSkipReason = "empty-heartbeat-file" | typeof HEARTBEAT_SKIP_NO_PENDING_EVENT;

type HeartbeatPreflight = HeartbeatWakePayloadFlags & {
  session: ReturnType<typeof resolveHeartbeatSessionSelection>;
  pendingEventEntries: ReturnType<typeof peekSystemEventEntries>;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  hasTaggedCronEvents: boolean;
  shouldInspectPendingEvents: boolean;
  authoritativeScheduledTick: boolean;
  skipReason?: HeartbeatSkipReason;
  scratchJobId?: string;
  scratchRevision?: number;
  heartbeatScratchContent?: string;
};

/**
 * Terminal no-op preflight (empty scratch, consumed exec events) must resolve
 * before retryable busy guards; wakes carrying heartbeat tasks keep deferral.
 */
export function shouldPreflightWakeBeforeBusy(
  source: HeartbeatWakeSource | undefined,
  scheduledEveryMs: number | undefined,
  scheduledTaskCount: number,
): boolean {
  return (
    scheduledTaskCount === 0 &&
    (source === "interval" ||
      (source === "exec-event" &&
        !(
          typeof scheduledEveryMs === "number" &&
          Number.isSafeInteger(scheduledEveryMs) &&
          scheduledEveryMs > 0
        )))
  );
}

export async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey?: string;
  reason?: string;
  source?: HeartbeatWakeSource;
  scheduledEveryMs?: number;
  scheduledTasks?: readonly HeartbeatScheduledTask[];
}): Promise<HeartbeatPreflight> {
  const wakeFlags = resolveHeartbeatWakePayloadFlags({
    source: params.source,
    reason: params.reason,
  });
  const session = resolveHeartbeatSessionSelection(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.sessionKey,
  );
  const pendingEventEntries = selectAgentSystemEvents(
    peekSystemEventEntries(session.sessionKey),
    params.agentId,
  ).filter((event) => !isHeartbeatDeliveryAwarenessEvent(event));
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // Wake-triggered runs inspect the queue they will drain. Restart and hook
  // producers enqueue on the configured/base session even when the model turn
  // runs in a fresh isolated `:heartbeat` session.
  const shouldInspectWakePendingEvents = wakeFlags.isWakePayload;
  const shouldInspectPendingEvents =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const shouldBypassScratchGates =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    wakeFlags.isWakePayload ||
    hasTaggedCronEvents;
  let monitorScratch: ReturnType<typeof readHeartbeatMonitorScratch>;
  try {
    monitorScratch = readHeartbeatMonitorScratch(
      resolveCronJobsStorePathFromConfig(params.cfg),
      params.agentId,
    );
  } catch (error) {
    log.warn(`heartbeat: scratch read failed: ${formatErrorMessage(error)}`);
  }
  const heartbeatScratchContent = monitorScratch?.state.scratch?.content;
  const basePreflight = {
    ...wakeFlags,
    session,
    pendingEventEntries,
    turnSourceDeliveryContext,
    hasTaggedCronEvents,
    shouldInspectPendingEvents,
    authoritativeScheduledTick:
      typeof params.scheduledEveryMs === "number" &&
      Number.isSafeInteger(params.scheduledEveryMs) &&
      params.scheduledEveryMs > 0,
    ...(monitorScratch?.jobId
      ? {
          scratchJobId: monitorScratch.jobId,
          scratchRevision: monitorScratch.state.currentRevision,
        }
      : {}),
    // Bypass scopes (cron/exec events and wake payloads) stay
    // self-contained: only the job identity travels so heartbeat_respond can
    // still persist scratch, never the monitor instructions themselves.
    ...(!shouldBypassScratchGates && heartbeatScratchContent !== undefined
      ? { heartbeatScratchContent }
      : {}),
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  // The exec completion can be acknowledged by process poll after its wake is
  // queued. Treat that stale wake as consumed without touching unrelated events.
  if (
    wakeFlags.isExecEventWake &&
    !basePreflight.authoritativeScheduledTick &&
    !params.scheduledTasks?.length &&
    !hasTaggedCronEvents &&
    !pendingEventEntries.some((event) => isExecCompletionEvent(event.text))
  ) {
    return {
      ...basePreflight,
      skipReason: HEARTBEAT_SKIP_NO_PENDING_EVENT,
    };
  }
  if (shouldBypassScratchGates) {
    return basePreflight;
  }
  // Cron owns task due-ness. Task wakes still receive ordinary scratch prose,
  // but empty or missing scratch must never suppress the independently scheduled job.
  if (params.scheduledTasks?.length) {
    return basePreflight;
  }
  if (heartbeatScratchContent === undefined) {
    // Without scratch, the model still gets the generic monitor prompt and
    // decides whether anything needs attention.
    return basePreflight;
  }
  if (isHeartbeatContentEffectivelyEmpty(heartbeatScratchContent)) {
    return {
      ...basePreflight,
      skipReason: "empty-heartbeat-file",
    };
  }
  return basePreflight;
}

type HeartbeatPromptResolution = {
  prompt: string;
  hasExecCompletion: boolean;
  hasRelayableExecCompletion: boolean;
  hasCronEvents: boolean;
  hasGenericEvents: boolean;
  handledSystemEvents: SystemEvent[];
  usesHeartbeatResponseTool: boolean;
  /**
   * Generic entries the composed prompt did not embed. Reply admission renders
   * and consumes exactly this selection; embedded entries are consumed by the
   * heartbeat delivery path after a successful run.
   */
  genericEvents: SystemEvent[];
  /**
   * Truncation-hidden content of handled entries; terminal consumption re-queues
   * these remainders so partially shown events are never silently dropped.
   */
  partialEventRemainders: Array<{ event: SystemEvent; remainder: string }>;
};

/** Appends monitor scratch prose to the generated heartbeat prompt. */
function appendHeartbeatScratch(prompt: string, heartbeatScratchContent?: string): string {
  if (!heartbeatScratchContent) {
    return prompt;
  }
  const directives = heartbeatScratchContent.trim();
  if (!directives || prompt.includes(directives)) {
    return prompt;
  }
  return `${prompt}\n\nHeartbeat monitor scratch:\n${directives}`;
}

export type HeartbeatEventOwnership = {
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
  hasGenericEvents: boolean;
  /** Retained entries the composed prompt surfaces; consumed after a successful run. */
  handledSystemEvents: SystemEvent[];
  /**
   * Generic entries the composed prompt did not embed. Reply admission renders
   * and consumes exactly this selection; embedded entries are consumed by the
   * heartbeat delivery path after a successful run.
   */
  genericEvents: SystemEvent[];
  /**
   * Truncation-hidden content of handled entries. Consuming a partially shown
   * event must re-queue its remainder so no queued content is silently dropped.
   */
  partialEventRemainders: Array<{ event: SystemEvent; remainder: string }>;
};

/**
 * Resolve which queued entries this turn owns before delivery is known: the
 * retained selection does not depend on relay or response-tool flags, so the
 * wake's turn-source delivery context can follow exactly the surfaced events.
 */
export function selectHeartbeatEventOwnership(params: {
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
}): HeartbeatEventOwnership {
  const pendingEventEntries = params.preflight.pendingEventEntries;
  const cronEventEntries = pendingEventEntries.filter(
    (event) =>
      (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
      isCronSystemEvent(event.text),
  );
  const execEventEntries = shouldInspectExecEventEntries(params)
    ? pendingEventEntries.filter((event) => isExecCompletionEvent(event.text))
    : [];
  const hasExecCompletion = execEventEntries.length > 0;
  const hasCronEvents = cronEventEntries.length > 0;
  const genericEventEntries = params.preflight.shouldInspectPendingEvents
    ? pendingEventEntries.filter(
        (event) =>
          !isExecCompletionEvent(event.text) &&
          !(
            (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
            isCronSystemEvent(event.text)
          ) &&
          !isHeartbeatNoiseEvent(event.text),
      )
    : [];
  const hasGenericEvents = genericEventEntries.length > 0;
  // When the composed prompt embeds generic events it is their only rendering
  // owner; otherwise the generic selection stays with reply admission.
  const deferredGenericEvents = params.preflight.shouldInspectPendingEvents
    ? []
    : pendingEventEntries.filter(
        (event) =>
          !isExecCompletionEvent(event.text) &&
          !(params.preflight.isCronWake || event.contextKey?.startsWith("cron:")),
      );
  const eventPromptResolution =
    hasExecCompletion || hasCronEvents || hasGenericEvents
      ? resolveHeartbeatEventPrompt({
          execEvents: execEventEntries.map((event) => event.text),
          cronEvents: cronEventEntries.map((event) => event.text),
          genericEvents: genericEventEntries.map((event) => event.text),
        })
      : undefined;
  const handledEventEntries = eventPromptResolution
    ? [
        ...eventPromptResolution.handledEventIndexes.exec.map((index) => execEventEntries[index]),
        ...eventPromptResolution.handledEventIndexes.cron.map((index) => cronEventEntries[index]),
        ...eventPromptResolution.handledEventIndexes.generic.map(
          (index) => genericEventEntries[index],
        ),
      ].filter((event): event is SystemEvent => event !== undefined)
    : [];
  const handledEventEntrySet = new Set(handledEventEntries);
  const remainderEventsByKind: Record<"exec" | "cron" | "generic", readonly SystemEvent[]> = {
    exec: execEventEntries,
    cron: cronEventEntries,
    generic: genericEventEntries,
  };
  const partialEventRemainders = (eventPromptResolution?.unseenRemainders ?? []).flatMap(
    (remainder) => {
      const event = remainderEventsByKind[remainder.kind][remainder.eventIndex];
      return event ? [{ event, remainder: remainder.text }] : [];
    },
  );
  return {
    hasExecCompletion,
    hasCronEvents,
    hasGenericEvents,
    handledSystemEvents: pendingEventEntries.filter((event) => handledEventEntrySet.has(event)),
    genericEvents: deferredGenericEvents,
    partialEventRemainders,
  };
}

export function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  startedAt: number;
  scheduledTasks: readonly HeartbeatScheduledTask[];
  heartbeatScratchContent?: string;
  useHeartbeatResponseTool: boolean;
  ownership?: HeartbeatEventOwnership;
}): HeartbeatPromptResolution {
  const pendingEventEntries = params.preflight.pendingEventEntries;
  const ownership =
    params.ownership ??
    selectHeartbeatEventOwnership({ preflight: params.preflight, heartbeat: params.heartbeat });
  const { hasExecCompletion, hasCronEvents, hasGenericEvents } = ownership;
  const { handledSystemEvents } = ownership;
  const execEventEntries = shouldInspectExecEventEntries(params)
    ? pendingEventEntries.filter((event) => isExecCompletionEvent(event.text))
    : [];
  const cronEventEntries = pendingEventEntries.filter(
    (event) =>
      (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
      isCronSystemEvent(event.text),
  );
  const genericEventEntries = params.preflight.shouldInspectPendingEvents
    ? pendingEventEntries.filter(
        (event) =>
          !isExecCompletionEvent(event.text) &&
          !(
            (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
            isCronSystemEvent(event.text)
          ) &&
          !isHeartbeatNoiseEvent(event.text),
      )
    : [];
  const hasRelayableExecCompletion =
    params.canRelayToUser &&
    execEventEntries.some((event) => isRelayableExecCompletionEvent(event.text));
  const deferredGenericEvents = ownership.genericEvents;
  if (params.scheduledTasks.length > 0) {
    const taskList = params.scheduledTasks
      .map((task) => `- ${task.name}: ${task.prompt}`)
      .join("\n");
    const completionInstruction = params.useHeartbeatResponseTool
      ? `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`
      : `After completing all due tasks, reply ${SILENT_REPLY_TOKEN}.`;
    const taskPrompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

${completionInstruction}`;
    const prompt = appendHeartbeatScratch(taskPrompt, params.heartbeatScratchContent);
    return {
      prompt,
      hasExecCompletion: false,
      hasRelayableExecCompletion: false,
      hasCronEvents: false,
      hasGenericEvents: false,
      handledSystemEvents: [],
      usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
      genericEvents: deferredGenericEvents,
      partialEventRemainders: [],
    };
  }

  const baseUsesHeartbeatResponseTool = params.useHeartbeatResponseTool;
  const eventPromptResolution =
    hasExecCompletion || hasCronEvents || hasGenericEvents
      ? resolveHeartbeatEventPrompt({
          execEvents: execEventEntries.map((event) => event.text),
          cronEvents: cronEventEntries.map((event) => event.text),
          genericEvents: genericEventEntries.map((event) => event.text),
          deliverToUser: params.canRelayToUser,
          useHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
        })
      : undefined;
  const basePrompt =
    eventPromptResolution?.prompt ??
    (baseUsesHeartbeatResponseTool
      ? resolveHeartbeatResponseToolPrompt(params.cfg, params.heartbeat)
      : resolveConfiguredHeartbeatPrompt(params.cfg, params.heartbeat));
  const basePromptWithDirectives = appendHeartbeatScratch(
    basePrompt,
    params.heartbeatScratchContent,
  );
  return {
    prompt: basePromptWithDirectives,
    hasExecCompletion,
    hasRelayableExecCompletion,
    hasCronEvents,
    hasGenericEvents,
    handledSystemEvents,
    usesHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
    genericEvents: deferredGenericEvents,
    partialEventRemainders: ownership.partialEventRemainders,
  };
}

function shouldInspectExecEventEntries(params: {
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
}): boolean {
  return (
    params.preflight.shouldInspectPendingEvents &&
    !(
      params.heartbeat?.isolatedSession === true &&
      params.preflight.isWakePayload &&
      !params.preflight.isCronWake &&
      !params.preflight.session.entry?.heartbeatIsolatedBaseSessionKey
    )
  );
}

export function selectSystemEventsConsumedByHeartbeat(params: {
  preflight: HeartbeatPreflight;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
  hasGenericEvents: boolean;
  handledSystemEvents: readonly SystemEvent[];
}): SystemEvent[] {
  const { preflight } = params;
  if (!preflight.shouldInspectPendingEvents || preflight.pendingEventEntries.length === 0) {
    return [];
  }
  if (
    preflight.isExecEventWake &&
    !params.hasExecCompletion &&
    !params.hasCronEvents &&
    (!params.hasGenericEvents || !preflight.isWakePayload)
  ) {
    return [];
  }
  if (
    preflight.isWakePayload &&
    !params.hasExecCompletion &&
    !params.hasCronEvents &&
    !params.hasGenericEvents &&
    preflight.pendingEventEntries.some((event) => isExecCompletionEvent(event.text))
  ) {
    return [];
  }
  if (params.hasExecCompletion || params.hasCronEvents || params.hasGenericEvents) {
    return [...params.handledSystemEvents];
  }
  return preflight.pendingEventEntries;
}
