/** Tests CLI compaction rotation and persisted transcript/session updates. */
import { describe, expect, it } from "vitest";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  readCompactionLifecyclePhases as readLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
  COMPACTION_ERROR,
  GATEWAY_INGRESS_ARGS,
  type ProviderModelNormalizationParams,
} from "./agent-command.compaction.test-support.js";
import type { CompactionAccountingFact } from "./embedded-agent-runner/run/internal-params.js";

const {
  acceptCompactionSuccessor,
  appendTranscriptMessage,
  loadSessionEntry,
  patchSessionEntryCore,
  createSessionDiffBaselineCaptureClaim,
  formatSqliteSessionFileMarker,
  listSessionEntriesCore,
  loadTranscriptEvents,
  replaceSessionEntry,
  SessionWorkStartInvalidatedError,
} = compactionTestRuntime;

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

async function commitAttemptCompaction(
  params: Parameters<typeof state.runAgentAttemptMock>[0],
  accounting: Pick<CompactionAccountingFact, "count" | "currentContextSnapshot"> = {
    count: 1,
    currentContextSnapshot: { tokens: 42 },
  },
) {
  const target = params.sessionTarget;
  if (!target) {
    throw new Error("expected command transcript target");
  }
  const entry = loadSessionEntry(target);
  if (!entry) {
    throw new Error("expected command predecessor");
  }
  const accepted = await acceptCompactionSuccessor({
    currentTarget: target,
    currentSessionFile: params.sessionFile,
    expectedEntry: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      activeWriterRunId: entry.activeWriterRunId,
    },
    assertActive: () => params.opts.abortSignal?.throwIfAborted(),
    result: {
      ok: true,
      compacted: true,
      result: { sessionId: "rotated-session", tokensBefore: 120, tokensAfter: 42 },
    },
  });
  params.onCompactionAccounting?.({
    kind: "durable",
    ...accounting,
    target: {
      ...accepted.sessionTarget,
      lifecycleRevision: accepted.entry.lifecycleRevision,
      activeWriterRunId: accepted.entry.activeWriterRunId,
    },
  });
  return accepted;
}

describe("agentCommand compaction transcript rotation", () => {
  it.each([
    ["settles a precreated baseline claim before embedded execution", false],
    ["does not execute after baseline work-start invalidation", true],
  ] as const)("%s", async (_name, invalidated) => {
    const sessionId = invalidated ? "invalidated-agent-command" : "precreated-agent-command",
      sessionKey = `agent:main:explicit:${sessionId}`;
    await replaceSessionEntry({ sessionKey, storePath: requireStorePath() }, {
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    } as InternalSessionEntry);
    if (invalidated) {
      const error = new SessionWorkStartInvalidatedError(
        "session changed during baseline settlement",
      );
      state.captureSessionDiffBaselineMock.mockRejectedValueOnce(error);
      await expect(
        agentCommand({ message: "must not execute", sessionId, sessionKey }),
      ).rejects.toBe(error);
      expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
      return;
    }
    state.captureSessionDiffBaselineMock.mockResolvedValueOnce({
      version: 1,
      sessionId,
      root: "/workspace",
      files: [],
    });
    state.runAgentAttemptMock.mockImplementationOnce(async () => {
      expect(findStoredSessionEntry(sessionKey)?.sessionDiffBaseline).toMatchObject({
        version: 1,
        sessionId,
      });
      return makeResult({ sessionId, text: "captured before execution" });
    });

    await agentCommand({ message: "write after capture", sessionId, sessionKey });
    expect(state.captureSessionDiffBaselineMock).toHaveBeenCalledOnce();
  });

  it("does not re-normalize an exact configured custom provider through plugin runtime", async () => {
    state.normalizeProviderModelIdWithRuntimeMock.mockImplementation(
      ({ provider }: ProviderModelNormalizationParams) => {
        if (provider === "tui-pty-mock") {
          throw new Error("custom provider should not use plugin runtime normalization");
        }
        return undefined;
      },
    );
    state.cfg = {
      ...state.cfg,
      plugins: {
        enabled: false,
      },
      agents: {
        defaults: {
          model: { primary: "tui-pty-mock/gpt-5.5" },
          models: {
            "tui-pty-mock/gpt-5.5": {},
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "tui-pty-mock": {
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "test",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "gpt-5.5",
                name: "GPT 5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "custom-provider-session",
        text: "custom answer",
      }),
    );

    await agentCommand({
      message: "custom provider prompt",
      sessionId: "custom-provider-session",
      cwd: state.workspaceDir,
    });

    const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | { providerOverride?: string; modelOverride?: string; pluginsEnabled?: boolean }
      | undefined;
    expect(attempt).toMatchObject({
      providerOverride: "tui-pty-mock",
      modelOverride: "gpt-5.5",
      pluginsEnabled: false,
      userTurnTranscriptRecorder: { message: { __openclaw: { senderIsOwner: true } } },
    });
    expect(state.normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "tui-pty-mock" }),
    );
    expect(state.loadManifestModelCatalogMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, "external_user", true],
    [true, "inter_session", false],
    [true, "internal_system", false],
    [false, "external_user", false],
  ] as const)(
    "preserves human transcript ownership for %s/%s",
    async (senderIsOwner, kind, owner) => {
      const inputProvenance = { kind, sourceTool: "test" };
      state.runAgentAttemptMock.mockResolvedValueOnce(
        makeResult({ sessionId: "owned", text: "ok" }),
      );
      await agentCommand({
        message: "remember",
        sessionId: "owned",
        senderIsOwner,
        inputProvenance,
      });
      expect(state.runAgentAttemptMock.mock.calls[0]?.[0]).toMatchObject({
        opts: { senderIsOwner, inputProvenance },
        userTurnTranscriptRecorder: {
          message: { provenance: inputProvenance, __openclaw: { senderIsOwner: owner } },
        },
      });
    },
  );

  it.each([42, 95_000, 0, undefined])(
    "keeps successor context %s from the private ordered fact, not public snapshots",
    async (tokens) => {
      const storePath = requireStorePath();
      const rotatedSessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "rotated-session",
        storePath,
      });
      const usage = { input: 100_000, output: 3_000, cacheRead: 20_000, cacheWrite: 1_000 };
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        const accepted = await commitAttemptCompaction(params, {
          count: 1,
          currentContextSnapshot: { tokens },
        });
        await appendTranscriptMessage(accepted.sessionTarget, {
          message: { role: "assistant", content: "first answer after rotation", timestamp: 1 },
        });
        const result = makeResult({
          sessionId: "native-thread-is-not-host-identity",
          text: "first answer after rotation",
          runner: "embedded",
        });
        result.meta.agentMeta = {
          sessionId: "native-thread-is-not-host-identity",
          sessionFile: rotatedSessionFile,
          provider: "openai",
          model: "gpt-5.5",
          compactionCount: 99,
          compactionTokensAfter: 42,
          promptTokens: 95_000,
          lastCallUsage: { input: 91_000, output: 1_000, cacheRead: 4_000 },
          usage,
        };
        return result;
      });

      await agentCommand({
        message: "first prompt",
        sessionId: "old-session",
        cwd: state.workspaceDir,
      });

      const entries = listSessionEntriesCore({ storePath });
      expect(entries).toHaveLength(1);
      const { sessionKey, entry } = entries[0]!;
      expect(sessionKey).toBe("agent:main:explicit:old-session");
      expect(entry).toMatchObject({
        sessionId: "rotated-session",
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: ["old-session", "rotated-session"],
        compactionCount: 1,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokensFresh: tokens !== undefined,
      });
      expect(entry.totalTokens).toBe(tokens);
      await expect(
        loadTranscriptEvents({ agentId: "main", sessionId: "rotated-session", storePath }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "assistant" }),
        }),
      );
    },
  );

  it("persists a count-zero model context against its private writer fact", async () => {
    const sessionId = "model-context-only";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const storePath = requireStorePath();
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      const entry = loadSessionEntry({ sessionKey, storePath });
      if (!entry || !params.sessionTarget) {
        throw new Error("expected a prepared command session");
      }
      await patchSessionEntryCore({ sessionKey, storePath }, () => ({
        activeWriterRunId: "current-command-writer",
      }));
      params.onCompactionAccounting?.({
        kind: "durable",
        count: 0,
        currentContextSnapshot: { tokens: 95_000 },
        target: {
          ...params.sessionTarget,
          lifecycleRevision: entry.lifecycleRevision,
          activeWriterRunId: "current-command-writer",
        },
      });
      const result = makeResult({ sessionId, text: "model answer", runner: "embedded" });
      result.meta.agentMeta = {
        sessionId,
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: 100_000, output: 3_000, cacheRead: 20_000 },
        compactionTokensAfter: 42,
      };
      return result;
    });

    await agentCommand({ message: "continue", sessionId, sessionKey });

    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      sessionId,
      activeWriterRunId: "current-command-writer",
      totalTokens: 95_000,
      totalTokensFresh: true,
      inputTokens: 100_000,
      outputTokens: 3_000,
      cacheRead: 20_000,
    });
    expect(findStoredSessionEntry(sessionKey)?.compactionCount).toBeUndefined();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
  });

  it("records completed compaction before a rejected attempt releases its writer", async () => {
    const storePath = requireStorePath();
    const sessionId = "aborted-command-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const controller = new AbortController();
    const aborted = new Error("caller aborted after compaction");
    aborted.name = "AbortError";
    let released = false;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      await patchSessionEntryCore({ sessionKey, storePath }, () => ({
        activeWriterRunId: params.runId,
      }));
      params.deferredLifecycle?.adopt({
        discard: () => {},
        complete: async () => {
          expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
            sessionId: "rotated-session",
            compactionCount: 2,
            activeWriterRunId: params.runId,
          });
          released = true;
        },
      });
      await commitAttemptCompaction(params, { count: 2, currentContextSnapshot: { tokens: 42 } });
      controller.abort(aborted);
      throw aborted;
    });

    await expect(
      agentCommand({
        message: "compact then stop",
        sessionId,
        sessionKey,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("caller aborted after compaction");

    expect(released).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "rotated-session",
      compactionCount: 2,
    });
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
  });

  it("carries Gateway plugin generation through failed post-turn compaction and still delivers", async () => {
    const sessionId = "cli-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "cli reply generated before compaction";
    const pluginGeneration = {
      pluginMetadataSnapshot: { workspaceDir: state.workspaceDir },
    } as never;
    let storedEntryBeforeCompaction: SessionEntry | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text, runner: "cli" }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      expect(params.pluginGeneration).toBe(pluginGeneration);
      storedEntryBeforeCompaction = findStoredSessionEntry(sessionKey);
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommandFromGatewayIngress(
      {
        message: "room message",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
      { config: state.cfg ?? {}, pluginGeneration },
    );

    expect(storedEntryBeforeCompaction).toMatchObject({
      pendingFinalDelivery: { kind: "replayable", text },
    });
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    expect(readLifecyclePhases()).toContain("end");
    expect(readLifecyclePhases()).not.toContain("error");
    const storedEntryAfterDelivery = findStoredSessionEntry(sessionKey);
    expect(storedEntryAfterDelivery?.pendingFinalDelivery).toBeUndefined();
  });

  it("excludes hidden reasoning from the pending final persisted before compaction", async () => {
    const sessionId = "reasoning-filter-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const hiddenReasoning = "private chain of thought";
    const visibleFinal = "visible final answer";
    let pendingTextSeenByCompaction: string | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId,
        text: visibleFinal,
        payloads: [{ text: hiddenReasoning, isReasoning: true }, { text: visibleFinal }],
      }),
    );
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      pendingTextSeenByCompaction =
        params.sessionEntry?.pendingFinalDelivery?.kind === "replayable"
          ? params.sessionEntry.pendingFinalDelivery.text
          : undefined;
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(pendingTextSeenByCompaction).toBe(visibleFinal);
    expect(pendingTextSeenByCompaction).not.toContain(hiddenReasoning);
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
  });

  it("preserves media directives in the pending final persisted before compaction", async () => {
    const sessionId = "media-directive-compaction-failure";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "Rendered chart\nMEDIA:/tmp/chart.png";
    let pendingTextSeenByCompaction: string | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
      pendingTextSeenByCompaction =
        params.sessionEntry?.pendingFinalDelivery?.kind === "replayable"
          ? params.sessionEntry.pendingFinalDelivery.text
          : undefined;
      throw new Error(COMPACTION_ERROR);
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(pendingTextSeenByCompaction).toBe(text);
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
  });

  it("adopts a successful compaction successor for delivery and marker cleanup", async () => {
    const sessionId = "pre-compaction-session";
    const successorSessionId = "post-compaction-session";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply carried across successful compaction";
    let successorBeforeCleanup: SessionEntry | undefined;
    let compactionSetupError: Error | undefined;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params, host) => {
      if (!params.sessionEntry || !params.sessionStore || !params.storePath) {
        compactionSetupError = new Error("compaction test requires persisted session state");
        throw compactionSetupError;
      }
      successorBeforeCleanup = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry(
        { sessionKey: params.sessionKey, storePath: params.storePath },
        successorBeforeCleanup,
      );
      params.sessionStore[params.sessionKey] = successorBeforeCleanup;
      host?.onCommitted?.({
        sessionId: successorSessionId,
        sessionFile: params.sessionKey,
        sessionTarget: {
          agentId: params.sessionAgentId,
          sessionId: successorSessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
        entry: successorBeforeCleanup,
        previousSessionId: params.sessionId,
      });
      return successorBeforeCleanup;
    });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(compactionSetupError).toBeUndefined();
    expect(successorBeforeCleanup).toMatchObject({
      sessionId: successorSessionId,
      pendingFinalDelivery: { kind: "replayable", text },
    });
    expect(result).toMatchObject({ deliverySucceeded: true });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: successorSessionId,
      pendingFinalDelivery: { kind: "replayable", text },
    });
    const storedSuccessor = findStoredSessionEntry(sessionKey);
    expect(storedSuccessor).toMatchObject({
      sessionId: successorSessionId,
    });
    expect(storedSuccessor?.pendingFinalDelivery).toBeUndefined();
    expect(storedSuccessor?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(storedSuccessor?.restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("retains the pending final when delivery fails after compaction failure", async () => {
    const sessionId = "delivery-failure-after-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const text = "reply awaiting restart recovery";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));
    state.runCliTurnCompactionLifecycleMock.mockRejectedValueOnce(new Error(COMPACTION_ERROR));
    state.deliverAgentCommandResultMock.mockResolvedValueOnce({ deliverySucceeded: false });

    const result = await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(result).toMatchObject({ deliverySucceeded: false });
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      pendingFinalDelivery: {
        kind: "replayable",
        text,
        context: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
  });

  it.each([
    ["empty payloads", "empty", []],
    ["a silent NO_REPLY payload", "silent", [{ text: "NO_REPLY" }]],
    ["a reasoning-only payload", "reasoning", [{ text: "hidden reasoning", isReasoning: true }]],
    ["a heartbeat-only payload", "heartbeat", [{ text: "HEARTBEAT_OK" }]],
    ["an outbound-suppressed relay placeholder", "relay-status", [{ text: "No channel reply." }]],
  ] as const)(
    "keeps compaction failure fatal for %s without manufacturing delivery state",
    async (_label, sessionSuffix, payloads) => {
      const sessionId = `no-reply-compaction-failure-${sessionSuffix}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      state.runAgentAttemptMock.mockResolvedValueOnce({
        payloads: [...payloads],
        meta: {
          durationMs: 1,
          stopReason: "end_turn",
          executionTrace: {
            runner: "cli",
            fallbackUsed: false,
            winnerProvider: "openai",
            winnerModel: "gpt-5.5",
          },
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.5",
          },
        },
      });
      state.runCliTurnCompactionLifecycleMock.mockRejectedValueOnce(new Error(COMPACTION_ERROR));

      await expect(
        agentCommand({
          message: "prompt with no assistant reply",
          sessionId,
          sessionKey,
          cwd: state.workspaceDir,
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          deliver: true,
        }),
      ).rejects.toThrow("Summarization failed: Connection error");

      expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      const storedEntry = findStoredSessionEntry(sessionKey);
      expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
      expect(readLifecyclePhases()).toContain("error");
    },
  );

  it("compacts after persisting transport ownership for finals that text cannot replay", async () => {
    const sessionId = "unrecoverable-media-before-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));

    await agentCommand({
      message: "room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads }),
    );
  });

  it("skips post-turn compaction when a recoverable final cannot persist a pending marker", async () => {
    const sessionId = "subagent-no-pending-marker";
    const sessionKey = `agent:main:subagent:${sessionId}`;
    const text = "subagent final must deliver before compaction";
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text }));

    const result = await agentCommand({
      message: "subagent room message",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: true,
    });

    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [{ text }] }),
    );
    expect(result).toMatchObject({ deliverySucceeded: true });
    const storedEntry = findStoredSessionEntry(sessionKey);
    expect(storedEntry?.pendingFinalDelivery).toBeUndefined();
  });

  it("keeps post-turn compaction for no-delivery runs with unrecoverable sendable finals", async () => {
    const sessionId = "unrecoverable-media-no-delivery";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const payloads = [{ mediaUrl: "/tmp/reply.ogg", audioAsVoice: true }];
    const successor = { sessionId: "unrecoverable-media-post-flush" } as SessionEntry;
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "", payloads }));
    const flush = state.runMemoryFlushIfNeededMock;
    flush.mockResolvedValueOnce({ sessionEntry: successor, outcome: "completed" });

    await agentCommand({
      message: "local model run",
      sessionId,
      sessionKey,
      cwd: state.workspaceDir,
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      deliver: false,
    });

    const compaction = state.runCliTurnCompactionLifecycleMock.mock.calls[0]?.[0];
    expect(compaction?.sessionId).toBe(successor.sessionId);
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
  });

  it("resumes the next turn from the rotated successor", async () => {
    const storePath = requireStorePath();
    const sessionKey = "agent:main:explicit:old-session";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: "rotated-session",
        updatedAt: Date.now(),
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: ["old-session", "rotated-session"],
        compactionCount: 1,
      },
    );
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        text: "second answer",
      }),
    );

    await agentCommand({
      message: "second prompt",
      sessionId: "rotated-session",
      cwd: state.workspaceDir,
    });

    const secondAttempt = state.runAgentAttemptMock.mock.calls[0]?.[0] as
      | {
          sessionId?: string;
          sessionKey?: string;
          sessionTarget?: {
            agentId?: string;
            sessionId?: string;
            sessionKey?: string;
            storePath?: string;
          };
        }
      | undefined;
    expect(secondAttempt).toMatchObject({
      sessionId: "rotated-session",
      sessionKey,
    });
    expect(secondAttempt?.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "rotated-session",
      sessionKey,
      storePath,
    });
    expect(state.deliveryFreshEntries.at(-1)).toMatchObject({
      sessionId: "rotated-session",
    });
    const persisted = Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ entry, sessionKey: key }) => [key, entry]),
    );
    expect(persisted[sessionKey]).toMatchObject({
      sessionId: "rotated-session",
    });
  });
});
