import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwnerByRunId,
} from "../agents/embedded-agent-runner/runs.js";
import { resolveActiveReplyRunOwnerForSignal } from "../auto-reply/reply/reply-run-registry.state.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";

export const realtimeVoiceControlRuntime = {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwnerByRunId,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveReplyRunOwnerForSignal,
  getDiagnosticSessionActivitySnapshot,
};
