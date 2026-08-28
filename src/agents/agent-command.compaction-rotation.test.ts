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

const {
  createSessionDiffBaselineCaptureClaim,
  formatSqliteSessionFileMarker,
  listSessionEntriesCore,
  loadTranscriptEvents,
  replaceSessionEntry,
  SessionWorkStartInvalidatedError,
} = compactionTestRuntime;

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

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

  it("keeps SQLite session state on the rotated successor", async () => {
    const storePath = requireStorePath();
    const rotatedSessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "rotated-session",
      storePath,
    });
    state.runAgentAttemptMock.mockResolvedValueOnce(
      makeResult({
        sessionId: "rotated-session",
        sessionFile: rotatedSessionFile,
        text: "first answer after rotation",
        compactionCount: 1,
      }),
    );

    await agentCommand({
      message: "first prompt",
      sessionId: "old-session",
      cwd: state.workspaceDir,
    });

    const storeAfterRotation = Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry]),
    );
    const entriesAfterRotation = Object.entries(storeAfterRotation);
    expect(entriesAfterRotation).toHaveLength(1);
    const [sessionKey, rotatedEntry] = entriesAfterRotation[0] ?? [];
    expect(sessionKey).toBe("agent:main:explicit:old-session");
    expect(rotatedEntry).toMatchObject({
      sessionId: "rotated-session",
      usageFamilyKey: "agent:main:explicit:old-session",
      usageFamilySessionIds: ["old-session", "rotated-session"],
      compactionCount: 1,
    });
    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId: "rotated-session", storePath }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "assistant" }),
      }),
    );
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
    state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
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
