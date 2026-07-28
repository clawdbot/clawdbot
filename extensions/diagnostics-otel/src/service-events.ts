import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "../api.js";
import { formatError } from "./service-exporter.js";
import type { createDiagnosticsLogExporter } from "./service-logs.js";
import type { createHarnessRecorders } from "./service-recorders-harness.js";
import type { createModelRecorders } from "./service-recorders-model.js";
import type { createOperationsRecorders } from "./service-recorders-operations.js";
import type { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import type { createUsageRecorders } from "./service-recorders-usage.js";
import type { OtelLogger } from "./service-types.js";

type DiagnosticsEventRecorders = ReturnType<typeof createHarnessRecorders> &
  ReturnType<typeof createModelRecorders> &
  ReturnType<typeof createOperationsRecorders> &
  ReturnType<typeof createToolAndSystemRecorders> &
  ReturnType<typeof createUsageRecorders>;

export function createDiagnosticsEventHandler(params: {
  logger: OtelLogger;
  recorders: DiagnosticsEventRecorders;
  recordLogRecord: ReturnType<typeof createDiagnosticsLogExporter>["recordLogRecord"];
  recordSecurityEvent: ReturnType<typeof createDiagnosticsLogExporter>["recordSecurityEvent"];
}) {
  const { logger, recorders, recordLogRecord, recordSecurityEvent } = params;
  const {
    recordModelUsage,
    recordWebhookReceived,
    recordWebhookProcessed,
    recordWebhookError,
    recordMessageQueued,
    recordMessageReceived,
    recordMessageDispatchStarted,
    recordMessageDispatchCompleted,
    recordMessageProcessed,
    recordMessageDeliveryStarted,
    recordMessageDeliveryCompleted,
    recordMessageDeliveryError,
    recordTalkEvent,
    recordLaneEnqueue,
    recordLaneDequeue,
    recordSessionState,
    recordSessionTurnCreated,
    recordSessionStuck,
    recordSessionRecoveryRequested,
    recordSessionRecoveryCompleted,
    recordRunAttempt,
    recordHeartbeat,
    recordLivenessWarning,
    recordDiagnosticPhaseCompleted,
    recordRunStarted,
    recordRunCompleted,
    recordHarnessRunStarted,
    recordHarnessRunCompleted,
    recordHarnessRunError,
    recordContextAssembled,
    recordModelCallStarted,
    recordModelCallCompleted,
    recordModelCallError,
    recordToolExecutionStarted,
    recordToolExecutionCompleted,
    recordToolExecutionError,
    recordToolExecutionBlocked,
    recordSkillUsed,
    recordExecProcessCompleted,
    recordToolLoop,
    recordMemorySample,
    recordMemoryPressure,
    recordAsyncQueueDropped,
    recordTelemetryExporter,
    recordPayloadLarge,
    recordModelFailover,
  } = recorders;
  return (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    try {
      switch (evt.type) {
        case "model.usage":
          recordModelUsage(evt, metadata);
          return;
        case "webhook.received":
          recordWebhookReceived(evt);
          return;
        case "webhook.processed":
          recordWebhookProcessed(evt);
          return;
        case "webhook.error":
          recordWebhookError(evt);
          return;
        case "message.queued":
          recordMessageQueued(evt);
          return;
        case "message.received":
          recordMessageReceived(evt);
          return;
        case "message.dispatch.started":
          recordMessageDispatchStarted(evt, metadata);
          return;
        case "message.dispatch.completed":
          recordMessageDispatchCompleted(evt);
          return;
        case "message.processed":
          recordMessageProcessed(evt, metadata);
          return;
        case "message.delivery.started":
          recordMessageDeliveryStarted(evt);
          return;
        case "message.delivery.completed":
          recordMessageDeliveryCompleted(evt, metadata);
          return;
        case "message.delivery.error":
          recordMessageDeliveryError(evt, metadata);
          return;
        case "talk.event":
          recordTalkEvent(evt, metadata);
          return;
        case "queue.lane.enqueue":
          recordLaneEnqueue(evt);
          return;
        case "queue.lane.dequeue":
          recordLaneDequeue(evt);
          return;
        case "session.state":
          recordSessionState(evt);
          break;
        case "session.long_running":
        case "session.stalled":
          break;
        case "session.turn.created":
          recordSessionTurnCreated(evt);
          return;
        case "session.stuck":
          recordSessionStuck(evt);
          return;
        case "session.recovery.requested":
          recordSessionRecoveryRequested(evt);
          return;
        case "session.recovery.completed":
          recordSessionRecoveryCompleted(evt);
          return;
        case "run.attempt":
          recordRunAttempt(evt);
          break;
        case "run.progress":
          break;
        case "run.execution_phase":
          break;
        case "diagnostic.heartbeat":
          recordHeartbeat(evt);
          return;
        case "diagnostic.liveness.warning":
          recordLivenessWarning(evt);
          return;
        case "diagnostic.phase.completed":
          recordDiagnosticPhaseCompleted(evt);
          return;
        case "run.started":
          recordRunStarted(evt, metadata);
          return;
        case "run.completed":
          recordRunCompleted(evt, metadata, privateData);
          return;
        case "harness.run.started":
          recordHarnessRunStarted(evt, metadata);
          return;
        case "harness.run.completed":
          recordHarnessRunCompleted(evt, metadata, privateData);
          return;
        case "harness.run.error":
          recordHarnessRunError(evt, metadata, privateData);
          return;
        case "context.assembled":
          recordContextAssembled(evt, metadata);
          return;
        case "model.call.started":
          recordModelCallStarted(evt, metadata);
          return;
        case "model.call.completed":
          recordModelCallCompleted(evt, metadata, privateData.modelContent);
          return;
        case "model.call.error":
          recordModelCallError(evt, metadata, privateData.modelContent);
          return;
        case "tool.execution.started":
          recordToolExecutionStarted(evt, metadata);
          return;
        case "tool.execution.completed":
          recordToolExecutionCompleted(evt, metadata, privateData.toolContent);
          return;
        case "tool.execution.error":
          recordToolExecutionError(evt, metadata, privateData.toolContent);
          return;
        case "tool.execution.blocked":
          recordToolExecutionBlocked(evt, metadata);
          return;
        case "skill.used":
          recordSkillUsed(evt, metadata);
          return;
        case "exec.process.completed":
          recordExecProcessCompleted(evt);
          break;
        case "exec.approval.followup_suppressed":
          break;
        case "log.record":
          recordLogRecord?.(evt, metadata);
          return;
        case "security.event":
          recordSecurityEvent?.(evt, metadata);
          return;
        case "tool.loop":
          recordToolLoop(evt);
          return;
        case "diagnostic.memory.sample":
          recordMemorySample(evt);
          return;
        case "diagnostic.memory.pressure":
          recordMemoryPressure(evt);
          return;
        case "diagnostic.async_queue.dropped":
          recordAsyncQueueDropped(evt);
          return;
        case "telemetry.exporter":
          recordTelemetryExporter(evt, metadata);
          return;
        case "payload.large":
          recordPayloadLarge(evt);
          return;
        case "model.failover":
          recordModelFailover(evt, metadata);
      }
    } catch (err) {
      logger.error(`diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`);
    }
  };
}
