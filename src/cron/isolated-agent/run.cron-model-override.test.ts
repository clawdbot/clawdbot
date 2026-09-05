// Cron model override tests cover model selection overrides for scheduled runs.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  loadSessionEntryMock,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveSessionAuthSelectionMock,
  restoreFastTestEnv,
  runWithModelFallbackMock,
  patchSessionEntryMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "digest-job",
    name: "Daily Digest",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "run daily digest",
      model: "anthropic/claude-sonnet-4-6",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run daily digest",
    sessionKey: "cron:digest",
    ...overrides,
  };
}

function makeFreshSessionEntry(overrides?: Record<string, unknown>) {
  return {
    ...makeCronSessionEntry(),
    // Crucially: no model or modelProvider — simulates a brand-new session
    model: undefined as string | undefined,
    modelProvider: undefined as string | undefined,
    ...overrides,
  };
}

function makeSuccessfulRunResult(overrides?: Record<string, unknown>) {
  return {
    result: {
      payloads: [{ text: "digest complete" }],
      meta: {
        agentMeta: {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          usage: { input: 100, output: 50 },
        },
      },
    },
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    attempts: [],
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — cron model override (#21057)", () => {
  let previousFastTestEnv: string | undefined;
  // Hold onto the cron session *object* — the code may reassign its
  // `sessionEntry` property (e.g. during skills snapshot refresh), so
  // checking a stale reference would give a false negative.
  let cronSession: ReturnType<typeof makeCronSession>;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    // Agent default model is Opus
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    // Cron payload model override resolves to Sonnet
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    resolveAgentConfigMock.mockReturnValue(undefined);
    cronSession = makeCronSession({
      sessionEntry: makeFreshSessionEntry(),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("persists cron payload model on session entry even when the run throws", async () => {
    // Simulate the agent run throwing (e.g. LLM provider timeout)
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");

    // The session entry should record the intended cron model override (Sonnet)
    // so that sessions_list does not fall back to the agent default (Opus).
    //
    // BUG (#21057): before the fix, the model was only written to the session
    // entry AFTER a successful run (in the post-run telemetry block), so it
    // remained undefined when the run threw in the catch block.
    expect(cronSession.sessionEntry.model).toBe("claude-sonnet-4-6");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
    expect(cronSession.sessionEntry.systemSent).toBe(true);
  });

  it("session entry already carries cron model at pre-run persist time (race condition)", async () => {
    // Capture a deep snapshot of the session entry at each persist call so we
    // can inspect what sessions_list would see mid-run — before the post-run
    // persist overwrites the entry with the actual model from agentMeta.
    const persistedSnapshots: Array<{
      model?: string;
      modelProvider?: string;
      systemSent?: boolean;
    }> = [];
    // The cron persist path calls patchSessionEntry(scope, updater, options);
    // the committed row is the updater's return, so snapshot that. Thread the
    // previously committed row forward as existingEntry so the lifecycle claim
    // guard proves ownership across the run's successive persists.
    const committedRows = new Map<string, SessionEntry>();
    patchSessionEntryMock.mockImplementation(
      async (
        scope: { storePath?: string; sessionKey: string },
        update: (
          entry: SessionEntry,
          context: { existingEntry: SessionEntry | undefined },
        ) => SessionEntry | null,
        options: { fallbackEntry?: SessionEntry } = {},
      ) => {
        const key = `${scope.storePath ?? ""}\0${scope.sessionKey}`;
        const committedRow = committedRows.get(key);
        const writeBase = committedRow ?? options.fallbackEntry;
        if (!writeBase) {
          return null;
        }
        const committed = update(structuredClone(writeBase), {
          existingEntry: committedRow ? structuredClone(committedRow) : undefined,
        });
        if (committed) {
          committedRows.set(key, structuredClone(committed));
          if (!scope.sessionKey.includes(":run:")) {
            persistedSnapshots.push(structuredClone(committed));
          }
        }
        return committed;
      },
    );

    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    await runCronIsolatedAgentTurn(makeParams());

    // Persist ordering: [0] skills snapshot, [1] pre-run model+systemSent,
    // [2] post-run telemetry.  Index 1 is what a concurrent sessions_list
    // would read while the agent run is in flight.
    expect(persistedSnapshots.length).toBeGreaterThanOrEqual(3);
    const preRunSnapshot = expectDefined(
      persistedSnapshots[1],
      "persistedSnapshots[1] test invariant",
    );
    expect(preRunSnapshot.model).toBe("claude-sonnet-4-6");
    expect(preRunSnapshot.modelProvider).toBe("anthropic");
    expect(preRunSnapshot.systemSent).toBe(true);
  });

  it("passes a configured model auth profile separately into cron auth selection", async () => {
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult({
        provider: "openai",
        model: "gpt-5.6-luna",
      }),
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-luna@openai:test-profile" },
            },
          },
          auth: {
            profiles: {
              "openai:test-profile": { provider: "openai", mode: "token" },
            },
          },
        },
        job: makeJob({
          payload: { kind: "agentTurn", message: "run daily digest" },
        }),
      }),
    );

    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.6-luna",
        configuredProfileId: "openai:test-profile",
      }),
    );
  });

  it("passes a payload model auth profile separately into cron auth selection", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      ref: { provider: "openai", model: "gpt-5.6-luna" },
    });
    runWithModelFallbackMock.mockResolvedValueOnce(
      makeSuccessfulRunResult({
        provider: "openai",
        model: "gpt-5.6-luna",
      }),
    );

    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          auth: {
            profiles: {
              "openai:test-profile": { provider: "openai", mode: "token" },
            },
          },
        },
        job: makeJob({
          payload: {
            kind: "agentTurn",
            message: "run daily digest",
            model: "openai/gpt-5.6-luna@openai:test-profile",
          },
        }),
      }),
    );

    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.6-luna",
        configuredProfileId: "openai:test-profile",
      }),
    );
  });

  it("returns error without persisting model when payload model is disallowed", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      error: "Model not allowed: anthropic/claude-sonnet-4-6",
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("Model not allowed");
    expect(result.diagnostics?.summary).toBe(
      "automation model override 'anthropic/claude-sonnet-4-6' rejected: Model not allowed: anthropic/claude-sonnet-4-6",
    );
    expect(result.diagnostics?.entries).toHaveLength(1);
    expect(result.diagnostics?.entries[0]?.ts).toBeTypeOf("number");
    expect(result.diagnostics?.entries[0]).toEqual({
      ts: result.diagnostics?.entries[0]?.ts,
      source: "cron-preflight",
      severity: "error",
      message:
        "automation model override 'anthropic/claude-sonnet-4-6' rejected: Model not allowed: anthropic/claude-sonnet-4-6",
    });
    // Model should remain undefined — the early return happens before the
    // pre-run persist block, so neither the session entry nor the store
    // should be touched with a rejected model.
    expect(cronSession.sessionEntry.model).toBeUndefined();
    expect(cronSession.sessionEntry.modelProvider).toBeUndefined();
  });

  it("persists session-level /model override on session entry before the run", async () => {
    // No cron payload model — the job has no model field
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "run daily digest" },
    });

    // Session-level /model override set by user (e.g. via /model command)
    cronSession.sessionEntry = makeFreshSessionEntry({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // resolveAllowedModelRef is called for the session override path too
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-haiku-4-5" },
    });

    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    expect(result.status).toBe("error");
    // Even though the run failed, the session-level model override should
    // be persisted on the entry — not the agent default (Opus).
    expect(cronSession.sessionEntry.model).toBe("claude-haiku-4-5");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });

  it.each([false, true])(
    "blocks required work when pre-run persistence fails without configured roles (%s)",
    async (required) => {
      let initialEntry: SessionEntry | undefined;
      if (required) {
        Object.assign(cronSession.sessionEntry, {
          createdActor: { type: "human", id: "profile-original-creator" },
          sandbox: "required",
        });
        initialEntry = { ...structuredClone(cronSession.sessionEntry), skillsSnapshot: undefined };
        cronSession.initialSessionEntry = initialEntry;
        loadSessionEntryMock.mockReturnValue(initialEntry);
      }
      // Persist ordering: [1] skills snapshot, [2] pre-run, [3] post-run.
      // Only the pre-run persist (call 2) should fail — the skills snapshot
      // persist is pre-existing code without a try-catch guard.
      let basePersistCount = 0;
      const committedRows = new Map<string, SessionEntry>();
      patchSessionEntryMock.mockImplementation(
        async (
          scope: { storePath?: string; sessionKey: string },
          update: (
            entry: SessionEntry,
            context: { existingEntry: SessionEntry | undefined },
          ) => SessionEntry | null,
          options: { fallbackEntry?: SessionEntry } = {},
        ) => {
          if (!scope.sessionKey.includes(":run:") && ++basePersistCount === 2) {
            throw new Error("ENOSPC: no space left on device");
          }
          const key = `${scope.storePath ?? ""}\0${scope.sessionKey}`;
          const current =
            committedRows.get(key) ??
            (scope.sessionKey.includes(":run:") ? undefined : initialEntry);
          const writeBase = current ?? options.fallbackEntry;
          if (!writeBase) {
            return null;
          }
          const committed = update(structuredClone(writeBase), {
            existingEntry: current ? structuredClone(current) : undefined,
          });
          if (committed) {
            committedRows.set(key, structuredClone(committed));
          }
          return committed;
        },
      );

      runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

      const running = runCronIsolatedAgentTurn(makeParams());
      if (required) {
        await expect(running).rejects.toThrow("ENOSPC");
        expect(runWithModelFallbackMock).not.toHaveBeenCalled();
      } else {
        await expect(running).resolves.toMatchObject({ status: "ok" });
        expect(runWithModelFallbackMock).toHaveBeenCalledOnce();
      }
      expect(logWarnMock).toHaveBeenCalledWith(
        "[cron:digest-job] Failed to persist pre-run session entry: Error: ENOSPC: no space left on device",
      );
    },
  );

  it("persists default model pre-run when no payload override is present", async () => {
    // No cron payload model override
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "run daily digest" },
    });

    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    expect(result.status).toBe("error");
    // With no override, the default model (Opus) should still be persisted
    // on the session entry rather than left undefined.
    expect(cronSession.sessionEntry.model).toBe("claude-opus-4-6");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });
});
