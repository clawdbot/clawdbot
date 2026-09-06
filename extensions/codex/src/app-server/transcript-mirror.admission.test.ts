import path from "node:path";
import {
  createAdmittedHostCapabilityTestFixture,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it } from "vitest";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import {
  captureCodexSettledTurnFinalizationContext,
  CodexSettledTurnContext,
} from "./settled-turn-context.js";
import {
  codexTranscriptMirrorRuntime,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";

registerCodexEventProjectorTestLifecycle();

it.each([undefined, "transport-user-key"])(
  "reuses the admitted prompt through native mirroring (source key: %s)",
  async (idempotencyKey) => {
    const createUserTurnTranscriptRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const base = await createParams();
    const target = {
      agentId: "main",
      sessionId: base.sessionId,
      sessionKey: "agent:main:monitor",
      storePath: path.join(base.workspaceDir, "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "Check the monitor.",
        provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      target: { ...target, sessionEntry: undefined },
      beforeMessageWrite: ({ message }) => message,
    });
    await recorder.persistApproved();
    const attempt = {
      ...base,
      ...target,
      sessionTarget: target,
      userTurnTranscriptRecorder: recorder,
    };
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    const params = { ...attempt, hostCapabilities: host.hostCapabilities };
    try {
      const mirror = {
        params,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        cwd: base.workspaceDir,
        threadId: "thread-1",
        turnId: "turn-1",
        notifyUserMessagePersisted: createCodexAppServerUserMessagePersistenceNotifier(params),
      };
      await mirrorPromptAtTurnStartBestEffort({
        ...mirror,
        upstreamUserText: "Check the monitor.",
      });
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1", {
        upstreamUserText: "Check the monitor.",
      });
      projector.recordDynamicToolCall({
        callId: "result",
        tool: "heartbeat_respond",
        arguments: {},
      });
      projector.recordDynamicToolResult({
        callId: "result",
        tool: "heartbeat_respond",
        success: true,
        terminalType: "completed",
        contentItems: [{ type: "inputText", text: "Monitor completed." }],
      });
      const result = projector.buildResult(buildEmptyToolTelemetry());
      const mirrored = await codexTranscriptMirrorRuntime.mirrorBestEffort({ ...mirror, result });
      await codexTranscriptMirrorRuntime.mirrorBestEffort({ ...mirror, result });
      const prompts = (await readSessionTranscriptEvents(target)).filter((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return asOptionalRecord(message?.["__openclaw"])?.mirrorIdentity === "turn-1:prompt";
      });
      expect(prompts).toHaveLength(1);
      if (idempotencyKey) {
        expect(recorder.getPersistedMessage?.()?.idempotencyKey).toBe(idempotencyKey);
      }
      const captured = await captureCodexSettledTurnFinalizationContext({
        ...target,
        sessionTarget: target,
        sessionFile: base.sessionFile,
        model: "gpt-5.6-luna",
        turnId: "turn-1",
        settledMessages: result.messagesSnapshot,
        mirroredMessages: mirrored.mirroredMessages,
      });
      expect(captured).toBeInstanceOf(CodexSettledTurnContext);
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  },
);
