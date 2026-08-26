import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isHeartbeatContentEffectivelyEmpty } from "../auto-reply/heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readHeartbeatMonitorScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { formatErrorMessage } from "./errors.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import {
  heartbeatLog,
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatResponseToolPrompt,
  type HeartbeatConfig,
} from "./heartbeat-runner-config.js";
import {
  resolveHeartbeatSession,
  resolveIsolatedHeartbeatSessionKey,
} from "./heartbeat-runner-session.js";
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
  session: ReturnType<typeof resolveHeartbeatSession>;
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

export function shouldPreflightExecEventWake(
  source: HeartbeatWakeSource | undefined,
  scheduledEveryMs: number | undefined,
  scheduledTaskCount: number,
): boolean {
  return (
    source === "exec-event" &&
    !(
      typeof scheduledEveryMs === "number" &&
      Number.isSafeInteger(scheduledEveryMs) &&
      scheduledEveryMs > 0
    ) &&
    scheduledTaskCount === 0
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
  const session = resolveHeartbeatSession(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.sessionKey,
  );
  const pendingEventEntries = selectAgentSystemEvents(
    peekSystemEventEntries(session.sessionKey),
    params.agentId,
  );
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // Wake-triggered runs should only inspect pending events when preflight peeks
  // the same queue that the run itself will execute/drain.
  const shouldInspectWakePendingEvents = (() => {
    if (!wakeFlags.isWakePayload) {
      return false;
    }
    if (params.heartbeat?.isolatedSession !== true) {
      return true;
    }
    const configuredSession = resolveHeartbeatSession(params.cfg, params.agentId, params.heartbeat);
    const { isolatedSessionKey } = resolveIsolatedHeartbeatSessionKey({
      agentId: params.agentId,
      sessionKey: session.sessionKey,
      configuredSessionKey: configuredSession.sessionKey,
      sessionEntry: session.entry,
    });
    return isolatedSessionKey === session.sessionKey;
  })();
  const shouldInspectPendingEvents =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const shouldBypassFileGates =
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
    ...(!shouldBypassFileGates && heartbeatScratchContent !== undefined
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
  if (shouldBypassFileGates) {
    return basePreflight;
  }
  // Cron owns task due-ness. Task wakes still receive ordinary scratch prose,
  // but empty or missing scratch must never suppress the independently scheduled job.
  if (params.scheduledTasks?.length) {
    return basePreflight;
  }
  if (heartbeatScratchContent === undefined) {
    // No scratch row preserves the old missing-file behavior: the model still
    // gets the generic heartbeat prompt and decides whether anything is due.
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
  usesHeartbeatResponseTool: boolean;
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

export function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  startedAt: number;
  scheduledTasks: readonly HeartbeatScheduledTask[];
  heartbeatScratchContent?: string;
  useHeartbeatResponseTool: boolean;
}): HeartbeatPromptResolution {
  const pendingEventEntries = params.preflight.pendingEventEntries;
  const cronEvents = pendingEventEntries
    .filter(
      (event) =>
        (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
        isCronSystemEvent(event.text),
    )
    .map((event) => event.text);
  const execEvents = params.preflight.shouldInspectPendingEvents
    ? pendingEventEntries
        .filter((event) => isExecCompletionEvent(event.text))
        .map((event) => event.text)
    : [];
  const hasExecCompletion = execEvents.length > 0;
  const hasRelayableExecCompletion =
    params.canRelayToUser && execEvents.some((event) => isRelayableExecCompletionEvent(event));
  const hasCronEvents = cronEvents.length > 0;
  if (params.scheduledTasks.length > 0) {
    const taskList = params.scheduledTasks
      .map((task) => `- ${task.name}: ${task.prompt}`)
      .join("\n");
    const completionInstruction = params.useHeartbeatResponseTool
      ? "After completing all due tasks, use heartbeat_respond to report the outcome. Set notify=false when nothing needs the user's attention."
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
      usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
    };
  }

  const baseUsesHeartbeatResponseTool = params.useHeartbeatResponseTool;
  const basePrompt = hasExecCompletion
    ? buildExecEventPrompt(execEvents, {
        deliverToUser: params.canRelayToUser,
        useHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
      })
    : hasCronEvents
      ? buildCronEventPrompt(cronEvents, {
          deliverToUser: params.canRelayToUser,
          useHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
        })
      : baseUsesHeartbeatResponseTool
        ? resolveHeartbeatResponseToolPrompt(params.cfg, params.heartbeat)
        : resolveConfiguredHeartbeatPrompt(params.cfg, params.heartbeat);
  const basePromptWithDirectives = appendHeartbeatScratch(
    basePrompt,
    params.heartbeatScratchContent,
  );
  return {
    prompt: basePromptWithDirectives,
    hasExecCompletion,
    hasRelayableExecCompletion,
    hasCronEvents,
    usesHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
  };
}

export function selectSystemEventsConsumedByHeartbeat(params: {
  preflight: HeartbeatPreflight;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
}): SystemEvent[] {
  const { preflight } = params;
  if (!preflight.shouldInspectPendingEvents || preflight.pendingEventEntries.length === 0) {
    return [];
  }
  if (params.hasExecCompletion) {
    return preflight.pendingEventEntries.filter((event) => isExecCompletionEvent(event.text));
  }
  if (params.hasCronEvents) {
    return preflight.pendingEventEntries.filter(
      (event) =>
        (preflight.isCronWake || event.contextKey?.startsWith("cron:")) &&
        isCronSystemEvent(event.text),
    );
  }
  if (preflight.isExecEventWake && !params.hasExecCompletion) {
    return [];
  }
  return preflight.pendingEventEntries;
}
