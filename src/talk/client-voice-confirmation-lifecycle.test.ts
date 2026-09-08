import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  noteClientVoiceConfirmationUtterance,
} from "./client-voice-confirmation.js";
import {
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "./client-voice-confirmation.test-support.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;

function registerRun(
  agentId: string,
  voiceSessionId: string,
  sessionKey: string,
  runId: string,
): void {
  registerClientVoiceConsultRun({
    agentId,
    sessionKey,
    voiceSessionId,
    runId,
  });
}

function bindGrant(agentId: string, voiceSessionId: string, runId: string, message: string): void {
  const grant = authorizeGrant(agentId, voiceSessionId, runId, message);
  expect(bindAuthorizedClientVoiceConfirmation({ grant, runId })).toBe(true);
}

function authorizeGrant(agentId: string, voiceSessionId: string, runId: string, message: string) {
  const requestedAt = Date.now();
  const blocked = checkClientVoiceToolConfirmationPolicy({
    agentId,
    voiceSessionId,
    runId,
    toolName: "message",
    toolParams: { action: "send", message },
    now: requestedAt,
  });
  if (blocked.allowed) {
    throw new Error("expected a pending voice confirmation");
  }
  const confirmationId = blocked.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
  if (!confirmationId) {
    throw new Error("expected a voice confirmation id");
  }
  noteClientVoiceConfirmationUtterance({
    agentId,
    voiceSessionId,
    text: "yes",
    timestamp: requestedAt + 1,
  });
  const grant = authorizeClientVoiceConfirmation({
    agentId,
    voiceSessionId,
    confirmationId,
    now: requestedAt + 2,
  });
  return grant;
}

async function completeRun(runId: string): Promise<void> {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 5,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();
}

describe("client voice confirmation lifecycle", () => {
  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-voice-confirmation-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it("keeps a live run's grant after close and releases it on completion", async () => {
    const sessionKey = "agent:main:active";
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    registerRun("main", voiceSessionId, sessionKey, "run-active");
    bindGrant("main", voiceSessionId, "run-active", "confirmed action");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      config: {},
    });

    expect(resolveClientVoiceRunBinding("run-active")).toMatchObject({ voiceSessionId });
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);

    await completeRun("run-active");
    expect(resolveClientVoiceRunBinding("run-active")).toBeUndefined();
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("keeps completion ownership after a close invalidates a detached grant", async () => {
    const sessionKey = "agent:main:stale-bind";
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const grant = authorizeGrant("main", voiceSessionId, "run-stale-bind", "cancelled action");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      config: {},
    });
    registerRun("main", voiceSessionId, sessionKey, "run-stale-bind");

    expect(
      bindAuthorizedClientVoiceConfirmation({
        grant,
        runId: "run-stale-bind",
      }),
    ).toBe(false);
    expect(resolveClientVoiceRunBinding("run-stale-bind")).toMatchObject({ voiceSessionId });
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);

    await completeRun("run-stale-bind");
    expect(resolveClientVoiceRunBinding("run-stale-bind")).toBeUndefined();
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });

  it("releases only the prior scope's grant when a run binding is replaced", async () => {
    const firstAgentId = "agent-a";
    const firstMessage = "first action";
    const firstSessionKey = "agent:agent-a:first";
    const firstVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: firstAgentId,
      sessionKey: firstSessionKey,
      origin: "client",
      voiceSessionId: "voice-first",
    });
    registerRun(firstAgentId, firstVoiceSessionId, firstSessionKey, "run-shared");
    bindGrant(firstAgentId, firstVoiceSessionId, "run-shared", firstMessage);
    await closeClientVoiceSession({
      agentId: firstAgentId,
      sessionKey: firstSessionKey,
      voiceSessionId: firstVoiceSessionId,
      config: {},
    });

    const replacementAgentId = "agent-b";
    const unrelatedSessionKey = "agent:agent-b:unrelated";
    const unrelatedVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: replacementAgentId,
      sessionKey: unrelatedSessionKey,
      origin: "client",
      voiceSessionId: "voice-unrelated",
    });
    registerRun(replacementAgentId, unrelatedVoiceSessionId, unrelatedSessionKey, "run-unrelated");
    bindGrant(replacementAgentId, unrelatedVoiceSessionId, "run-unrelated", "unrelated action");
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(2);

    const replacementSessionKey = "agent:agent-b:replacement";
    const replacementVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: replacementAgentId,
      sessionKey: replacementSessionKey,
      origin: "client",
      voiceSessionId: "voice-replacement",
    });
    registerRun(replacementAgentId, replacementVoiceSessionId, replacementSessionKey, "run-shared");

    expect(resolveClientVoiceRunBinding("run-shared")).toMatchObject({
      voiceSessionId: replacementVoiceSessionId,
    });
    expect(resolveClientVoiceRunBinding("run-unrelated")).toMatchObject({
      voiceSessionId: unrelatedVoiceSessionId,
    });
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
    expect(
      checkClientVoiceToolConfirmationPolicy({
        agentId: firstAgentId,
        voiceSessionId: firstVoiceSessionId,
        runId: "run-shared",
        toolName: "message",
        toolParams: { action: "send", message: firstMessage },
      }).allowed,
    ).toBe(false);

    await completeRun("run-unrelated");
    expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(0);
  });
});
