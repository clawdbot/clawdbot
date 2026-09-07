// Boundary proof for #138316: a CLI-backed forum-topic cron run must keep its
// delayed exec completion in the originating topic. The route crosses four
// production owners after the executor hands it to the CLI runner (loopback
// grant, gateway tool resolution, exec notify queue, heartbeat delivery), so
// this drives all of them with a real background process instead of asserting
// the executor's parameters alone.
import { afterEach, expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { buildCliMcpGrantContext } from "../../agents/cli-runner/mcp-grant-context.js";
import { createAgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runHeartbeatOnce } from "../../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "../../infra/heartbeat-runner.test-utils.js";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  getChannelPluginMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runCliAgentMock,
} from "./run.test-harness.js";

await loadRunCronIsolatedAgentTurn();
const { executeCronRun } = await import("./run-executor.js");

const TOPIC_CHAT = "-1003774691294";
const TOPIC_ID = 47;
const TOPIC_TARGET = `${TOPIC_CHAT}:topic:${TOPIC_ID}`;
// The conversation a route-less completion falls back to, per #138316.
const OWNER_DM = "-100999999999";
// Cron run keys are agent-scoped, so the exec completion is queued on the
// agent's main session and relayed by that session's heartbeat.
const CRON_RUN_SESSION_KEY = "agent:main:cron:topic-cron:run:test-run-id";
const HEARTBEAT_QUEUE_KEY = "agent:main:main";

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

it("keeps a CLI-backed topic cron's delayed exec completion in the originating topic", async () => {
  const previousFastTestEnv = clearFastTestEnv();
  resetRunCronIsolatedAgentTurnHarness();
  resetSystemEventsForTest();
  // One Telegram plugin serves both halves of the run: the outbound facade the
  // heartbeat delivers through, plus Telegram's current-channel resolver shape
  // from extensions/telegram/src/channel.ts.
  getChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "telegram"
      ? {
          ...heartbeatRunnerTelegramPlugin,
          threading: {
            ...heartbeatRunnerTelegramPlugin.threading,
            resolveCurrentChannelId: ({
              to,
              threadId,
            }: {
              to: string;
              threadId?: string | number | null;
            }) => (threadId == null ? to : `${to}:topic:${threadId}`),
          },
        }
      : undefined,
  );
  try {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
        tools: { exec: { notifyOnExit: true, backgroundMs: 0 } },
      } as never;
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: OWNER_DM,
      });

      mockRunCronFallbackPassthrough();
      isCliProviderMock.mockReturnValue(true);
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      });

      await executeCronRun({
        cfg: {},
        cfgWithAgentDefaults: {},
        job: {
          id: "topic-cron",
          name: "Topic Cron",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "run the backup" },
          delivery: { mode: "announce", channel: "telegram", to: TOPIC_CHAT },
        },
        agentId: "main",
        agentDir: tmpDir,
        agentSessionKey: "agent:main:cron:topic-cron",
        runSessionKey: CRON_RUN_SESSION_KEY,
        workspaceDir: tmpDir,
        agentVerboseDefault: undefined,
        immutableThinkLevel: undefined,
        loadThinkingCatalog: async () => [],
        timeoutMs: 60_000,
        suppressExecNotifyOnExit: false,
        resolvedDeliveryOk: true,
        sourceDelivery: createSourceDeliveryPlan({
          owner: "direct_fallback",
          reason: "cron_announce",
          target: {
            channel: "telegram",
            to: TOPIC_CHAT,
            accountId: "ops",
            threadId: TOPIC_ID,
          },
          messageToolEnabled: true,
          messageToolForced: false,
          requireExplicitMessageTarget: true,
          requireExplicitMessageTargetEvidence: true,
          directFallback: true,
        }),
        skillsSnapshot: emptySkillsSnapshot,
        agentPayload: null,
        useSubagentFallbacks: false,
        liveSelection: { provider: "openai", model: "gpt-5.4" },
        cronSession: makeCronSession() as unknown as MutableCronSession,
        commandBody: "run the backup",
        persistSessionEntry: async () => undefined,
        lifecycle: createAgentLifecycleTerminalBackstop({
          runId: "test-run-id",
          sessionKey: CRON_RUN_SESSION_KEY,
          getLifecycleGeneration: getAgentEventLifecycleGeneration,
          resolveTerminationFields: () => ({}),
        }),
        abortReason: () => "aborted",
        isAborted: () => false,
        resolvedDelivery: {
          channel: "telegram",
          accountId: "ops",
          to: TOPIC_CHAT,
          threadId: TOPIC_ID,
        },
      } as never);

      // The CLI runner is the only stubbed hop: the run parameters it receives
      // are the fact under test, and everything downstream is production code.
      const cliRun = runCliAgentMock.mock.calls[0]?.[0];
      expect(cliRun).toBeDefined();
      const grant = buildCliMcpGrantContext({
        run: cliRun,
        config: cfg,
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "openai",
        modelId: "gpt-5.4",
      });
      const scoped = resolveGatewayScopedTools({
        ...grant,
        cfg,
        surface: "loopback",
        conversationReadOrigin: "delegated",
        mediatedToolNames: new Set(["exec", "process"]),
        workspaceDir: tmpDir,
      } as never);
      const execTool = scoped.tools.find((tool) => tool.name === "exec") as unknown as {
        execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
      };
      expect(execTool).toBeDefined();

      await execTool.execute("cron-topic-call", {
        command: "echo cron-topic-marker",
        background: true,
      });
      await expect
        .poll(() => peekSystemEventEntries(HEARTBEAT_QUEUE_KEY).length, { timeout: 15_000 })
        .toBe(1);
      // Read before the heartbeat consumes the queue entry.
      const queuedCompletion = peekSystemEventEntries(HEARTBEAT_QUEUE_KEY)[0];

      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: TOPIC_CHAT });
      replySpy.mockResolvedValue({ text: "Backup finished" });
      const heartbeat = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: {
          getQueueSize: () => 0,
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      } as never);

      expect(heartbeat.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledOnce();
      // Pre-fix the completion carried no route and landed on the session's
      // last target (the owner DM) instead of the forum topic.
      expect(sendTelegram.mock.calls[0]?.[0]).toBe(TOPIC_TARGET);
      expect(queuedCompletion?.deliveryContext).toMatchObject({
        channel: "telegram",
        to: TOPIC_TARGET,
        accountId: "ops",
        threadId: String(TOPIC_ID),
      });
    });
  } finally {
    restoreFastTestEnv(previousFastTestEnv);
  }
});
