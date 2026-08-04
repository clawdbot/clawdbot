import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions,
} from "./main-session-restart-recovery.js";
import { claimSessionsSendDeferredCompletion } from "./sessions-send-deferred-store.js";
import {
  armSessionsSendDeferredCompletion,
  disarmSessionsSendDeferredCompletion,
  finishSessionsSendDeferredContinuationAfterTranscript,
  maybeCompleteSessionsSendDeferred,
  prepareSessionsSendDeferredCompletion,
  recoverSessionsSendDeferredCompletions,
  testing,
} from "./sessions-send-deferred.js";

const targetRunId = "target-run-1";
const targetSessionKey = "agent:research:main";
const requesterSessionKey = "agent:main:telegram:dm:123";
const requesterSessionId = "requester-session-1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions_send deferred completion", () => {
  let stateDir: string;
  let options: { env: NodeJS.ProcessEnv };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-sessions-send-deferred-");
    options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    testing.resetPendingRunIds();
  });

  afterEach(() => {
    testing.resetPendingRunIds();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabase();
  });

  function arm(overrides: Partial<Parameters<typeof armSessionsSendDeferredCompletion>[0]> = {}) {
    return armSessionsSendDeferredCompletion(
      {
        targetRunId,
        targetSessionKey,
        requesterSessionKey,
        requesterSessionId,
        requesterOrigin: {
          channel: "telegram",
          to: "7504982318",
          accountId: "primary",
          threadId: "42",
        },
        requestMessage: "Find the deployment failure",
        ...overrides,
      },
      options,
    );
  }

  it("lazily creates its table in an existing current-schema database", () => {
    const initial = openOpenClawStateDatabase(options);
    initial.db.exec("DROP TABLE sessions_send_deferred_completions;");
    closeOpenClawStateDatabase();

    const reopened = openOpenClawStateDatabase(options);
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions_send_deferred_completions';",
        )
        .get(),
    ).toBeUndefined();

    arm();
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions_send_deferred_completions';",
        )
        .get(),
    ).toEqual({ name: "sessions_send_deferred_completions" });
  });

  it("recovers a prepared completion after settlement and restart", async () => {
    arm();
    expect(
      prepareSessionsSendDeferredCompletion(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "The deployment failed during migration." }] },
        },
        options,
      ),
    ).toBe(true);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabase();
    testing.resetPendingRunIds();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await expect(recoverSessionsSendDeferredCompletions({ dispatch }, options)).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        expectedExistingSessionId: requesterSessionId,
        channel: "telegram",
        to: "7504982318",
        accountId: "primary",
        threadId: "42",
        deliver: true,
        bestEffortDeliver: false,
        sourceReplyDeliveryMode: "automatic",
      }),
    );
    expect(dispatch.mock.calls[0]?.[0]?.message).toContain(
      "The deployment failed during migration.",
    );
    expect(
      finishSessionsSendDeferredContinuationAfterTranscript(
        String(dispatch.mock.calls[0]?.[0]?.idempotencyKey),
        options,
      ),
    ).toBe(true);

    await expect(recoverSessionsSendDeferredCompletions({ dispatch }, options)).resolves.toEqual({
      recovered: 0,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not readmit a continuation whose user turn survived gateway restart", async () => {
    arm();
    const acceptedRuns: string[] = [];
    const dispatch = vi.fn(async (params: Record<string, unknown>) => {
      const continuationRunId = String(params.idempotencyKey);
      acceptedRuns.push(continuationRunId);
      await upsertSessionEntry(
        {
          agentId: "main",
          env: options.env,
          sessionKey: requesterSessionKey,
        },
        {
          sessionId: requesterSessionId,
          status: "running",
          updatedAt: Date.now(),
          restartRecoveryDeliveryRunId: continuationRunId,
          restartRecoveryDeliveryContext: {
            channel: "telegram",
            to: "7504982318",
            accountId: "primary",
            threadId: "42",
          },
        },
      );
      await appendTranscriptMessage(
        {
          agentId: "main",
          env: options.env,
          sessionId: requesterSessionId,
          sessionKey: requesterSessionKey,
        },
        {
          message: {
            role: "user",
            content: String(params.message),
            timestamp: Date.now(),
            idempotencyKey: buildRunUserTurnIdempotencyKey(continuationRunId),
          },
          idempotencyLookup: "scan",
        },
      );
      return { runId: continuationRunId, status: "accepted" };
    });
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Durable result" }] },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(true);
    expect(acceptedRuns).toHaveLength(1);

    // Simulate process death after Gateway acceptance and transcript commit,
    // but before the transcript observer retires the deferred SQLite row.
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabase();
    testing.resetPendingRunIds();
    dispatch.mockClear();

    await expect(recoverSessionsSendDeferredCompletions({ dispatch }, options)).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(acceptedRuns).toHaveLength(1);
    const postRestartAdmissions: Record<string, unknown>[] = [];
    const gatewayRuntime: GatewayRecoveryRuntime = {
      dispatchAgent: async <T>(params: Record<string, unknown>) => {
        postRestartAdmissions.push(params);
        return { runId: "restart-recovery-run" } as T;
      },
      waitForAgent: async <T>() => ({ status: "ok" }) as T,
      sendRecoveryNotice: async <T>() => ({ ok: true }) as T,
    };
    await expect(
      markStartupOrphanedMainSessionsForRecovery({
        activeSessionIds: [],
        activeSessionKeys: [],
        cfg: {},
        stateDir,
        updatedBeforeMs: Date.now() + 1,
      }),
    ).resolves.toMatchObject({ marked: 1 });
    await expect(
      recoverRestartAbortedMainSessions({
        activeSessionIds: [],
        activeSessionKeys: [],
        cfg: {},
        gatewayRuntime,
        stateDir,
      }),
    ).resolves.toMatchObject({ recovered: 1, failed: 0 });
    expect(postRestartAdmissions).toHaveLength(1);
    await expect(recoverSessionsSendDeferredCompletions({ dispatch }, options)).resolves.toEqual({
      recovered: 0,
      failed: 0,
    });
  });

  it("replays a claimed dispatch after restart with the same idempotency key", async () => {
    arm();
    prepareSessionsSendDeferredCompletion(
      {
        targetRunId,
        targetSessionKey,
        terminalOutcome: { status: "ok", reason: "completed" },
        result: { payloads: [{ text: "Recovered result" }] },
      },
      options,
    );
    const claimed = claimSessionsSendDeferredCompletion({ targetRunId, targetSessionKey }, options);
    expect(claimed?.continuationRunId).toBeTruthy();
    await upsertSessionEntry(
      {
        agentId: "main",
        env: options.env,
        sessionKey: requesterSessionKey,
      },
      {
        sessionId: requesterSessionId,
        status: "running",
        updatedAt: Date.now(),
        restartRecoveryDeliveryRunId: claimed?.continuationRunId,
      },
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabase();
    testing.resetPendingRunIds();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await expect(recoverSessionsSendDeferredCompletions({ dispatch }, options)).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: claimed?.continuationRunId }),
    );
  });

  it("leaves an ambiguous dispatch failure replayable after restart", async () => {
    arm();
    const failedDispatch = vi.fn(async (_params: Record<string, unknown>) => {
      throw new Error("connection closed before acceptance");
    });
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Recovered result" }] },
          dispatch: failedDispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    const failedIdempotencyKey = failedDispatch.mock.calls[0]?.[0]?.idempotencyKey;

    closeOpenClawStateDatabase();
    testing.resetPendingRunIds();
    const recoveredDispatch = vi.fn(async (_params: Record<string, unknown>) => ({
      status: "accepted",
    }));
    await expect(
      recoverSessionsSendDeferredCompletions({ dispatch: recoveredDispatch }, options),
    ).resolves.toEqual({ recovered: 1, failed: 0 });
    expect(recoveredDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: failedIdempotencyKey }),
    );
  });

  it("rejects a mismatched target session without consuming the registration", async () => {
    arm();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey: "agent:forged:main",
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("wakes the requester with terminal failure context", async () => {
    arm();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await maybeCompleteSessionsSendDeferred(
      {
        targetRunId,
        targetSessionKey,
        terminalOutcome: {
          status: "error",
          reason: "failed",
          error: "provider authentication failed",
        },
        dispatch,
      },
      options,
    );

    expect(dispatch.mock.calls[0]?.[0]?.message).toContain("provider authentication failed");
  });

  it("keeps concurrent target completions bound to their respective origins", async () => {
    arm({ targetRunId: "telegram-run" });
    arm({
      targetRunId: "slack-run",
      targetSessionKey: "agent:operations:main",
      requesterSessionKey: "agent:main:slack:channel:ops",
      requesterSessionId: "requester-session-2",
      requesterOrigin: {
        channel: "slack",
        to: "C01234567",
        accountId: "workspace",
        threadId: "1721592000.000100",
      },
    });
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await Promise.all([
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "slack-run",
          targetSessionKey: "agent:operations:main",
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Slack result" }] },
          dispatch,
        },
        options,
      ),
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "telegram-run",
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Telegram result" }] },
          dispatch,
        },
        options,
      ),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:ops",
        expectedExistingSessionId: "requester-session-2",
        channel: "slack",
        to: "C01234567",
        accountId: "workspace",
        threadId: "1721592000.000100",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        expectedExistingSessionId: requesterSessionId,
        channel: "telegram",
        to: "7504982318",
        accountId: "primary",
        threadId: "42",
      }),
    );
  });

  it("does not dispatch explicitly cancelled or expired registrations", async () => {
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));
    arm();
    disarmSessionsSendDeferredCompletion({ targetRunId }, options);
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);

    arm({ targetRunId: "expired-run", ttlMs: -1 });
    testing.resetPendingRunIds();
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "expired-run",
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when the requester origin is missing or internal", () => {
    expect(() => arm({ requesterOrigin: { channel: "telegram" } })).toThrow(
      "explicit external requester delivery context",
    );
    expect(() =>
      arm({ requesterOrigin: { channel: "sessions_send", to: requesterSessionKey } }),
    ).toThrow("explicit external requester delivery context");
  });

  it("never substitutes the provider default for an accountless multi-account origin", async () => {
    const providerDefaultDispatch = vi.fn(async (_params: Record<string, unknown>) => ({
      status: "accepted",
    }));
    expect(() =>
      arm({
        requesterOrigin: {
          channel: "telegram",
          to: "7504982318",
        },
      }),
    ).toThrow("with accountId");
    await expect(
      recoverSessionsSendDeferredCompletions({ dispatch: providerDefaultDispatch }, options),
    ).resolves.toEqual({ recovered: 0, failed: 0 });
    expect(providerDefaultDispatch).not.toHaveBeenCalled();
  });
});
