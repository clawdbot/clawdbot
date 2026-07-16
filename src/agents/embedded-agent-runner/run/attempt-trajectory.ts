/** Creates and seeds the attempt-local trajectory recorder. */
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { buildTrajectoryRunMetadata } from "../../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { AgentSession } from "../../sessions/index.js";
import { resolveAttemptTrajectorySessionFile } from "./attempt-transcript-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedAttemptTrajectory(input: {
  activeSession: Pick<AgentSession, "sessionId">;
  attempt: EmbeddedRunAttemptParams;
  clientToolCount: number;
  effectiveToolCount: number;
  effectiveWorkspace: string;
  localModelLeanEnabled: boolean;
  sessionAgentId: string;
  systemPromptReport?: SessionSystemPromptReport;
}): Promise<ReturnType<typeof createTrajectoryRuntimeRecorder> | null> {
  const { activeSession, attempt } = input;
  const trajectorySessionFile = await resolveAttemptTrajectorySessionFile({
    agentId: input.sessionAgentId,
    config: attempt.config,
    sessionFile: attempt.sessionFile,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
  });
  const recorder = attempt.disableTrajectory
    ? null
    : createTrajectoryRuntimeRecorder({
        cfg: attempt.config,
        env: process.env,
        runId: attempt.runId,
        sessionId: activeSession.sessionId,
        sessionKey: attempt.sessionKey,
        sessionFile: trajectorySessionFile,
        provider: attempt.provider,
        modelId: attempt.modelId,
        modelApi: attempt.model.api,
        workspaceDir: attempt.workspaceDir,
      });
  recorder?.recordEvent("session.started", {
    trigger: attempt.trigger,
    sessionFile: attempt.sessionFile,
    workspaceDir: input.effectiveWorkspace,
    agentId: input.sessionAgentId,
    messageProvider: attempt.messageProvider,
    messageChannel: attempt.messageChannel,
    localModelLean: input.localModelLeanEnabled,
    toolCount: input.effectiveToolCount,
    clientToolCount: input.clientToolCount,
  });
  const fastMode = typeof attempt.fastMode === "boolean" ? attempt.fastMode : undefined;
  recorder?.recordEvent(
    "trace.metadata",
    buildTrajectoryRunMetadata({
      env: process.env,
      config: attempt.config,
      workspaceDir: input.effectiveWorkspace,
      sessionFile: attempt.sessionFile,
      sessionKey: attempt.sessionKey,
      agentId: input.sessionAgentId,
      trigger: attempt.trigger,
      messageProvider: attempt.messageProvider,
      messageChannel: attempt.messageChannel,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      timeoutMs: attempt.timeoutMs,
      fastMode,
      thinkLevel: attempt.thinkLevel,
      reasoningLevel: attempt.reasoningLevel,
      toolResultFormat: attempt.toolResultFormat,
      disableTools: attempt.disableTools,
      toolsAllow: attempt.toolsAllow,
      skillsSnapshot: attempt.skillsSnapshot,
      systemPromptReport: input.systemPromptReport,
    }),
  );
  return recorder;
}
