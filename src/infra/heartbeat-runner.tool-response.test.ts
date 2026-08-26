// Covers heartbeat tool-response handling and visible reply policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../agents/failover/user-copy.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { recordReplyOperationAgentTurn } from "../auto-reply/reply/reply-operation-agent-turn-state.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  deleteCronJobScratch,
  readCronJobScratchState,
  readHeartbeatMonitorScratch,
} from "../cron/scratch-store.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { isRetryableHeartbeatSkipReason } from "./heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();

describe("heartbeat event previews", () => {
  it("keeps the 200-code-unit preview UTF-16 well-formed", () => {
    expect(truncateHeartbeatPreview(`${"x".repeat(199)}🚀tail`)).toBe("x".repeat(199));
    expect(truncateHeartbeatPreview(undefined)).toBeUndefined();
  });
});

describe("runHeartbeatOnce heartbeat response tool", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  afterEach(() => {
    vi.unstubAllEnvs();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  function createConfig(params: {
    tmpDir: string;
    storePath: string;
    visibleReplies?: "automatic" | "message_tool";
    groupVisibleReplies?: "automatic" | "message_tool";
    agentRuntimeId?: string;
    modelRuntimeId?: string;
    model?: string;
    isolatedSession?: boolean;
    target?: "telegram" | "last" | "none";
    showOk?: boolean;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
            ...(params.isolatedSession ? { isolatedSession: true } : {}),
          },
          ...(params.model ? { model: params.model } : {}),
          ...(params.model && params.modelRuntimeId
            ? { models: { [params.model]: { agentRuntime: { id: params.modelRuntimeId } } } }
            : {}),
          ...(params.agentRuntimeId ? { agentRuntime: { id: params.agentRuntimeId } } : {}),
        },
      },
      ...(params.visibleReplies || params.groupVisibleReplies
        ? {
            messages: {
              ...(params.visibleReplies ? { visibleReplies: params.visibleReplies } : {}),
              ...(params.groupVisibleReplies
                ? { groupChat: { visibleReplies: params.groupVisibleReplies } }
                : {}),
            },
          }
        : {}),
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: params.showOk ?? false },
        },
      },
      session: { store: params.storePath },
    } as OpenClawConfig;
  }

  function createDeps(params: {
    sendTelegram: ReturnType<typeof vi.fn>;
    getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"];
  }): HeartbeatDeps {
    return {
      telegram: params.sendTelegram as unknown,
      getQueueSize: () => 0,
      nowMs: () => 0,
      getReplyFromConfig: params.getReplyFromConfig,
    };
  }

  function seedTelegramSession(
    storePath: string,
    cfg: OpenClawConfig,
    entry: Partial<Parameters<typeof seedMainSessionStore>[2]> = {},
  ) {
    return seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: TELEGRAM_GROUP,
      ...entry,
    });
  }

  function runHeartbeat(
    cfg: OpenClawConfig,
    replySpy: HeartbeatDeps["getReplyFromConfig"],
    sendTelegram: ReturnType<typeof vi.fn>,
    overrides: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {},
  ) {
    return runHeartbeatOnce({
      cfg,
      ...overrides,
      deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
    });
  }

  function expectTelegramSend(
    sendTelegram: ReturnType<typeof vi.fn>,
    params: { text: string; cfg: OpenClawConfig; silent?: boolean },
  ) {
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram.mock.calls).toEqual([
      [
        TELEGRAM_GROUP,
        params.text,
        {
          verbose: false,
          cfg: params.cfg,
          accountId: undefined,
          ...(params.silent !== undefined ? { silent: params.silent } : {}),
        },
      ],
    ]);
  }

  function replyCall(replySpy: ReturnType<typeof vi.fn>): unknown[] {
    const call = replySpy.mock.calls[0];
    if (!call) {
      throw new Error("Expected reply call");
    }
    return call;
  }

  function setAgentTurnStatus(
    options: object | undefined,
    status: "ok" | "failed" | "superseded" | "cancelled",
  ) {
    const runState = resolveReplyOperationRunState(options);
    if (!runState) {
      throw new Error("Expected heartbeat reply operation run state");
    }
    recordReplyOperationAgentTurn(runState, status);
  }

  function replyContext(replySpy: ReturnType<typeof vi.fn>): {
    Body?: string;
    SessionKey?: string;
  } {
    const context = replyCall(replySpy)[0];
    if (!context || typeof context !== "object") {
      throw new Error("Expected reply context");
    }
    return context as { Body?: string; SessionKey?: string };
  }

  function replyOptions(replySpy: ReturnType<typeof vi.fn>): {
    enableHeartbeatTool?: boolean;
    forceHeartbeatTool?: boolean;
    sourceReplyDeliveryMode?: string;
  } {
    const options = replyCall(replySpy)[1];
    if (!options || typeof options !== "object") {
      throw new Error("Expected reply options");
    }
    return options as {
      enableHeartbeatTool?: boolean;
      forceHeartbeatTool?: boolean;
      sourceReplyDeliveryMode?: string;
    };
  }

  async function runWithToolResponse(response: HeartbeatToolResponse) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(createHeartbeatToolResponsePayload(response));
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      return { result, sendTelegram, replySpy, cfg };
    });
  }

  function createTerminalToolFailureReply(response: HeartbeatToolResponse, warning?: string) {
    const metadata = {
      heartbeatTerminalToolFailure: { toolName: "message" },
    } as const;
    const heartbeatPayload = setReplyPayloadMetadata(
      createHeartbeatToolResponsePayload(response),
      metadata,
    );
    return warning
      ? [heartbeatPayload, setReplyPayloadMetadata({ text: warning, isError: true }, metadata)]
      : heartbeatPayload;
  }

  async function runPlainFallbackReply(text: string, options: { showOk?: boolean } = {}) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, showOk: options.showOk });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue({ text });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      return { result, sendTelegram, replySpy, cfg };
    });
  }

  async function runPromptScenario(
    params: {
      config?: Partial<Parameters<typeof createConfig>[0]>;
      session?: Partial<Parameters<typeof seedMainSessionStore>[2]>;
      beforeSeed?: (params: {
        tmpDir: string;
        storePath: string;
        cfg: OpenClawConfig;
      }) => Promise<void>;
      tasks?: Parameters<typeof runHeartbeatOnce>[0]["tasks"];
    } = {},
  ) {
    return await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, ...params.config });
      await params.beforeSeed?.({ tmpDir, storePath, cfg });
      await seedTelegramSession(storePath, cfg, params.session);
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await runHeartbeat(cfg, replySpy, sendTelegram, { tasks: params.tasks });

      return {
        calledCtx: replyContext(replySpy),
        calledOpts: replyOptions(replySpy),
      };
    });
  }

  function expectHeartbeatToolPrompt(
    result: Awaited<ReturnType<typeof runPromptScenario>>,
    extraBodyText: string[] = [],
  ) {
    for (const text of extraBodyText) {
      expect(result.calledCtx.Body).toContain(text);
    }
    expect(result.calledCtx.Body).toContain("heartbeat_respond");
    expect(result.calledCtx.Body).not.toContain("HEARTBEAT_OK");
    expect(result.calledOpts.enableHeartbeatTool).toBe(true);
    expect(result.calledOpts.forceHeartbeatTool).toBe(true);
    expect(result.calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
  }

  it("treats notify=false as a quiet heartbeat ack", async () => {
    const { result, sendTelegram } = await runWithToolResponse({
      outcome: "no_change",
      notify: false,
      summary: "Nothing needs attention.",
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("commits a scratch replacement without exposing it as reply channel data", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const jobId = await seedHeartbeatScratchForTest({ content: "old scratch" });
      await seedTelegramSession(storePath, cfg);
      const reply = createHeartbeatToolResponsePayload({
        outcome: "progress",
        notify: false,
        summary: "Updated monitor context.",
        scratch: "new private scratch",
      });
      expect(JSON.stringify(reply)).not.toContain("new private scratch");
      replySpy.mockResolvedValue(reply);

      const result = await runHeartbeat(cfg, replySpy, vi.fn(), { source: "manual" });

      expect(result.status).toBe("ran");
      expect(readCronJobScratchState(resolveCronJobsStorePath(), jobId).scratch?.content).toBe(
        "new private scratch",
      );
    });
  });

  it.each([
    { turnStatus: "superseded" as const, reason: "preempted" },
    { turnStatus: "cancelled" as const, reason: "agent-runner-cancelled" },
  ])("retains heartbeat work and scratch after $turnStatus", async ({ turnStatus, reason }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const jobId = await seedHeartbeatScratchForTest({ content: "old scratch" });
      const previousHeartbeat = {
        lastHeartbeatText: "Previous successful heartbeat.",
        lastHeartbeatSentAt: 123,
      };
      const sessionKey = await seedTelegramSession(storePath, cfg, previousHeartbeat);
      enqueueSystemEvent("exec finished: backup completed", { sessionKey });
      const inspectedEvents = peekSystemEventEntries(sessionKey);
      replySpy.mockImplementationOnce(async (_ctx, options) => {
        setAgentTurnStatus(options, turnStatus);
        return createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: true,
          summary: "Backup completed.",
          scratch: "new private scratch",
        });
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const execWake = { source: "exec-event", intent: "event", reason: "exec-event" } as const;
      const result = await runHeartbeat(cfg, replySpy, sendTelegram, execWake);

      expect(result).toEqual({ status: "skipped", reason });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
      expect(readCronJobScratchState(resolveCronJobsStorePath(), jobId).scratch?.content).toBe(
        "old scratch",
      );
      expect(readSessionStoreForTest(storePath)[sessionKey]).toMatchObject(previousHeartbeat);
      expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason });
      expect(isRetryableHeartbeatSkipReason(reason)).toBe(turnStatus === "superseded");
    });
  });

  it("does not recreate scratch when its monitor is deleted while the heartbeat runs", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const cronStorePath = resolveCronJobsStorePath();
      const monitor = readHeartbeatMonitorScratch(cronStorePath, "main");
      expect(monitor).toBeDefined();
      if (!monitor) {
        throw new Error("Expected seeded heartbeat monitor");
      }
      deleteCronJobScratch(cronStorePath, monitor.jobId);
      await seedTelegramSession(storePath, cfg);
      replySpy.mockImplementation(async () => {
        await saveCronJobsStore(cronStorePath, { version: 1, jobs: [] });
        return createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Updated monitor context.",
          scratch: "late scratch write",
        });
      });

      const result = await runHeartbeat(cfg, replySpy, vi.fn(), { source: "manual" });

      expect(result.status).toBe("ran");
      expect(readCronJobScratchState(cronStorePath, monitor.jobId)).toEqual({
        currentRevision: 0,
      });
    });
  });

  it("persists a meaningful quiet outcome for the base session", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Deployment completed; smoke test pending.",
          nextCheck: "next scheduled heartbeat",
        }),
      );

      await runHeartbeat(cfg, replySpy, vi.fn(), {
        source: "manual",
        reason: "operator check",
      });

      expect(
        claimHeartbeatOutcomeForRun({
          agentId: "main",
          sessionKey,
          storePath,
          runId: "user-run",
        }),
      ).toMatchObject({
        outcome: "progress",
        summary: "Deployment completed; smoke test pending.",
        wakeSource: "manual",
        wakeReason: "operator check",
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    });
  });

  it("delivers notificationText when notify=true", async () => {
    const { sendTelegram, cfg } = await runWithToolResponse({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });

    expectTelegramSend(sendTelegram, {
      text: "Build is blocked on missing credentials.",
      cfg,
    });
  });

  it("reports a quiet terminal tool failure without external delivery for target none", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, target: "none" });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      enqueueSystemEvent("exec finished: delivery probe completed", { sessionKey });
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply({
          outcome: "no_change",
          notify: false,
          summary: "Message delivery was denied.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: "Message delivery was denied.",
        silent: true,
      });
    });
  });

  it("does not deliver a suppressed quiet terminal failure to an explicit target", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply({
          outcome: "no_change",
          notify: false,
          summary: "Message delivery was denied.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: "Message delivery was denied.",
        silent: true,
      });
    });
  });

  it("delivers a terminal tool warning without recording successful delivery bookkeeping", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      const warning = "⚠️ Message failed";
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply(
          {
            outcome: "no_change",
            notify: false,
            summary: "Message delivery was denied.",
          },
          warning,
        ),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);
      const sessionStore = readSessionStoreForTest<{
        lastHeartbeatText?: string;
      }>(storePath);

      expect(result).toEqual({ status: "failed", reason: "agent-tool-failure" });
      expectTelegramSend(sendTelegram, { text: warning, cfg });
      expect(sessionStore[sessionKey]?.lastHeartbeatText).toBeUndefined();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        preview: warning,
        channel: "telegram",
      });
    });
  });

  it("retains composite pending-final content after delivering only its terminal warning", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const warning = "⚠️ Message failed";
      const pendingText = `Original exec completion\n\n${warning}`;
      const sessionKey = await seedTelegramSession(storePath, cfg);
      replySpy.mockImplementation(async () => {
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({
            pendingFinalDelivery: {
              kind: "replayable",
              text: pendingText,
              createdAt: Date.now(),
            },
          }),
          { preserveActivity: true },
        );
        return createTerminalToolFailureReply(
          { outcome: "no_change", notify: false, summary: "Message delivery was denied." },
          warning,
        );
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });

      const sessionStore = readSessionStoreForTest<{
        pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
      }>(storePath);
      expectTelegramSend(sendTelegram, { text: warning, cfg });
      expect(sessionStore[sessionKey]).toMatchObject({
        pendingFinalDelivery: expect.objectContaining({
          kind: "replayable",
          text: pendingText,
        }),
      });
    });
  });

  it("clears an exact pending-final warning after delivering it", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const warning = "⚠️ Message failed";
      const sessionKey = await seedTelegramSession(storePath, cfg);
      replySpy.mockImplementation(async () => {
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({
            pendingFinalDelivery: {
              kind: "replayable",
              text: warning,
              createdAt: Date.now(),
            },
          }),
          { preserveActivity: true },
        );
        return createTerminalToolFailureReply(
          { outcome: "no_change", notify: false, summary: "Message delivery was denied." },
          warning,
        );
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });

      const sessionStore = readSessionStoreForTest<{
        pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
      }>(storePath);
      expectTelegramSend(sendTelegram, { text: warning, cfg });
      expect(sessionStore[sessionKey]?.pendingFinalDelivery).toBeUndefined();
    });
  });

  it("keeps terminal failure status when its warning delivery fails", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        createTerminalToolFailureReply(
          { outcome: "blocked", notify: true, summary: "Message delivery was denied." },
          "⚠️ Message failed",
        ),
      );
      const sendTelegram = vi.fn().mockRejectedValue(new Error("channel unavailable"));

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-tool-failure",
        silent: true,
      });
    });
  });

  it("preserves media when delivering a plain terminal failure reply", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      const mediaUrl = "https://example.test/failure.png";
      replySpy.mockResolvedValue(
        setReplyPayloadMetadata(
          { text: "Message delivery failed.", mediaUrl },
          { heartbeatTerminalToolFailure: { toolName: "message" } },
        ),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await expect(
        runHeartbeatOnce({
          cfg,
          deps: createDeps({ sendTelegram, getReplyFromConfig: replySpy }),
        }),
      ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });
      expect(sendTelegram).toHaveBeenCalledOnce();
      expect(sendTelegram.mock.calls[0]?.[2]).toMatchObject({ mediaUrl });
    });
  });

  it("converts trailing notify=false fallback text into silent Telegram delivery", async () => {
    const { result, sendTelegram, cfg } = await runPlainFallbackReply(
      "No interruption needed.\n\nnotify=false",
    );

    expect(result.status).toBe("ran");
    expectTelegramSend(sendTelegram, {
      text: "No interruption needed.",
      cfg,
      silent: true,
    });
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "sent",
      preview: "No interruption needed.",
      channel: "telegram",
      silent: true,
    });
  });

  it.each(["\n", "\r\n"])(
    "strips trailing notify=false with suffix %j without rerunning a heartbeat",
    async (suffix) => {
      const { result, sendTelegram, cfg } = await runPlainFallbackReply(
        `No interruption needed.\n\nnotify=false${suffix}`,
      );

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        text: "No interruption needed.",
        cfg,
        silent: true,
      });
    },
  );

  it("suppresses marker-only notify=false fallback replies", async () => {
    const { result, sendTelegram } = await runPlainFallbackReply("notify=false\r\n", {
      showOk: true,
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "ok-token",
      channel: "telegram",
      silent: true,
    });
  });

  it("preserves inline notify=false fallback text", async () => {
    const { result, sendTelegram, cfg } = await runPlainFallbackReply(
      "The literal notify=false flag is documented.",
    );

    expect(result.status).toBe("ran");
    expectTelegramSend(sendTelegram, {
      text: "The literal notify=false flag is documented.",
      cfg,
    });
  });

  it.each([
    {
      name: "global message-tool reply policy",
      visibleReplies: "message_tool" as const,
      target: "telegram" as const,
      chatType: "direct" as const,
    },
    {
      name: "group-specific message-tool reply policy",
      groupVisibleReplies: "message_tool" as const,
      target: "last" as const,
      chatType: "group" as const,
    },
  ])("keeps a heartbeat's unmarked final private under $name", async (policy) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, ...policy });
      await seedTelegramSession(storePath, cfg, { chatType: policy.chatType });
      replySpy.mockResolvedValue({
        text: "Private heartbeat reasoning with HEARTBEAT_OK inside the sentence.",
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expect(replyOptions(replySpy).sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "ok-token",
        channel: "telegram",
        silent: true,
      });
    });
  });

  it("keeps marked operator notices visible in message-tool heartbeat mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "message_tool" });
      await seedTelegramSession(storePath, cfg);
      const notice = "The configured model backend needs operator attention.";
      replySpy.mockResolvedValue(markReplyPayloadForSourceSuppressionDelivery({ text: notice }));
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, { text: notice, cfg });
    });
  });

  it("keeps ordinary heartbeat finals visible under automatic reply policy", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "automatic" });
      await seedTelegramSession(storePath, cfg);
      const text = "The heartbeat found a deployment requiring your attention.";
      replySpy.mockResolvedValue({ text });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, { text, cfg });
    });
  });

  it("uses the heartbeat response tool prompt in message-tool mode", async () => {
    const result = await runPromptScenario({
      config: { visibleReplies: "message_tool" },
    });

    expectHeartbeatToolPrompt(result, ["notify=false"]);
  });

  it("uses the heartbeat response tool prompt for group message-tool mode", async () => {
    const result = await runPromptScenario({
      config: { groupVisibleReplies: "message_tool", target: "last" },
      session: { lastTo: "group:redacted" },
    });

    expectHeartbeatToolPrompt(result, ["notify=false"]);
  });

  it("uses the heartbeat response tool prompt for the default Codex runtime", async () => {
    const result = await runPromptScenario();

    expectHeartbeatToolPrompt(result);
  });

  it("uses the isolated Codex runtime instead of the base OpenClaw runtime", async () => {
    // One direction proves prompt recalculation after isolation. Reciprocal
    // runtime precedence is covered directly by thinking-runtime.test.ts.
    const result = await runPromptScenario({
      config: { isolatedSession: true },
      session: {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        agentRuntimeOverride: "openclaw",
      },
    });

    expect(result.calledCtx.SessionKey).toMatch(/:heartbeat$/);
    expectHeartbeatToolPrompt(result);
  });

  it("delivers Codex runtime failure notices during Codex heartbeat message-tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg, { agentHarnessId: "codex" });
      const usageLimitMessage =
        "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: usageLimitMessage,
          isError: true,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      const calledOpts = replyOptions(replySpy);
      expect(result.status).toBe("ran");
      expect(calledOpts.sourceReplyDeliveryMode).toBe("message_tool_only");
      expectTelegramSend(sendTelegram, {
        text: usageLimitMessage,
        cfg,
      });
    });
  });

  it("retains inspected work and dedupe state after delivering a runner failure notice", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const previousHeartbeatText = "Previous successful heartbeat.";
      const previousHeartbeatSentAt = 123;
      const sessionKey = await seedTelegramSession(storePath, cfg, {
        lastHeartbeatText: previousHeartbeatText,
        lastHeartbeatSentAt: previousHeartbeatSentAt,
      });
      enqueueSystemEvent("exec finished: retryable deployment check", { sessionKey });
      const inspectedEvents = peekSystemEventEntries(sessionKey);
      replySpy.mockImplementationOnce(async (_ctx, options) => {
        setAgentTurnStatus(options, "failed");
        return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const failedResult = await runHeartbeat(cfg, replySpy, sendTelegram, {
        reason: "exec-event",
      });
      const failedSessionStore = readSessionStoreForTest<{
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
      }>(storePath);

      expect(failedResult).toEqual({ status: "failed", reason: "agent-runner-failure" });
      expectTelegramSend(sendTelegram, { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, cfg });
      expect(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT).not.toContain("/new");
      expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
      expect(failedSessionStore[sessionKey]).toMatchObject({
        lastHeartbeatText: previousHeartbeatText,
        lastHeartbeatSentAt: previousHeartbeatSentAt,
      });

      replySpy.mockImplementationOnce(async (_ctx, options) => {
        setAgentTurnStatus(options, "ok");
        return createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: true,
          summary: "Queued work completed.",
          notificationText: "Queued work completed successfully.",
        });
      });
      sendTelegram.mockClear();

      const successfulResult = await runHeartbeat(cfg, replySpy, sendTelegram, {
        reason: "exec-event",
      });

      expect(successfulResult.status).toBe("ran");
      expectTelegramSend(sendTelegram, { text: "Queued work completed successfully.", cfg });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    });
  });

  it("keeps an unmarked runner failure private while retaining inspected work", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        tmpDir,
        storePath,
        visibleReplies: "message_tool",
      });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      enqueueSystemEvent("exec finished: private retryable failure", { sessionKey });
      const inspectedEvents = peekSystemEventEntries(sessionKey);
      replySpy.mockImplementation(async (_ctx, options) => {
        setAgentTurnStatus(options, "failed");
        return [
          {
            ...createHeartbeatToolResponsePayload({
              outcome: "progress",
              notify: true,
              summary: "Public tool summary.",
              notificationText: "Public tool notification.",
            }),
            mediaUrl: "https://example.test/public.png",
          },
          {
            text: "Private heartbeat reasoning.",
            mediaUrl: "https://example.test/private.png",
          },
        ];
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-runner-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason: "agent-runner-failure",
        silent: true,
      });
    });
  });

  it("rewrites a runner failure after an earlier heartbeat response", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockImplementation(async (_ctx, options) => {
        setAgentTurnStatus(options, "failed");
        return [
          createHeartbeatToolResponsePayload({
            outcome: "no_change",
            notify: false,
            summary: "Nothing needs attention.",
          }),
          { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true },
        ];
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-runner-failure" });
      expectTelegramSend(sendTelegram, { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, cfg });
      expect(HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT).not.toContain("/new");
    });
  });

  it("keeps a silent failed agent turn out of heartbeat ack paths", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      const sessionKey = await seedTelegramSession(storePath, cfg);
      enqueueSystemEvent("cron finished: retryable silent failure", { sessionKey });
      const inspectedEvents = peekSystemEventEntries(sessionKey);
      replySpy.mockImplementation(async (_ctx, options) => {
        setAgentTurnStatus(options, "failed");
        return { text: SILENT_REPLY_TOKEN };
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result).toEqual({ status: "failed", reason: "agent-runner-failure" });
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
    });
  });

  it("suppresses internal stream-error fallback placeholders before heartbeat delivery", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        markReplyPayloadForSourceSuppressionDelivery({
          text: `${STREAM_ERROR_FALLBACK_TEXT}\n${STREAM_ERROR_FALLBACK_TEXT}`,
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      const result = await runHeartbeat(cfg, replySpy, sendTelegram);

      expect(result.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "ok-token",
        channel: "telegram",
        silent: true,
      });
    });
  });

  it("uses the heartbeat response tool prompt for auto-selected Codex model sessions", async () => {
    const result = await runPromptScenario({
      config: {
        agentRuntimeId: "auto",
        model: "openai/gpt-5.5",
      },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("uses the heartbeat response tool prompt for model-specific Codex runtimes", async () => {
    const result = await runPromptScenario({
      config: {
        model: "openai/gpt-5.5",
        modelRuntimeId: "codex",
      },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("honors model-specific non-Codex runtimes over default Codex heartbeat mode", async () => {
    const result = await runPromptScenario({
      config: {
        agentRuntimeId: "codex",
        model: "openai/gpt-5.5",
        modelRuntimeId: "native",
      },
    });

    expect(result.calledCtx.Body).toContain(SILENT_REPLY_TOKEN);
    expect(result.calledCtx.Body).not.toContain("heartbeat_respond");
    expect(result.calledOpts.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("uses the heartbeat response tool prompt when the Codex runtime is env-forced", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    const result = await runPromptScenario({
      config: { model: "openai/gpt-5.5" },
    });

    expectHeartbeatToolPrompt(result);
  });

  it("uses the heartbeat response tool prompt for due heartbeat tasks", async () => {
    const result = await runPromptScenario({
      config: { visibleReplies: "message_tool" },
      tasks: [{ jobId: "job-status", name: "status", prompt: "Check deployment status" }],
    });

    expectHeartbeatToolPrompt(result, [
      "Run the following periodic tasks",
      "Check deployment status",
    ]);
  });

  it("uses the canonical silent reply prompt outside heartbeat response tool mode", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ tmpDir, storePath, visibleReplies: "automatic" });
      await seedTelegramSession(storePath, cfg);
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "no_change",
          notify: false,
          summary: "Nothing needs attention.",
        }),
      );
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });

      await runHeartbeat(cfg, replySpy, sendTelegram);

      const calledCtx = replyContext(replySpy);
      const calledOpts = replyOptions(replySpy);
      expect(calledCtx.Body).toContain(SILENT_REPLY_TOKEN);
      expect(calledCtx.Body).not.toContain("heartbeat_respond");
      expect(calledOpts.enableHeartbeatTool).toBeUndefined();
      expect(calledOpts.forceHeartbeatTool).toBeUndefined();
      expect(calledOpts.sourceReplyDeliveryMode).toBeUndefined();
    });
  });
});
