import { describe, expect, it, vi } from "vitest";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunOptions } from "../infra/heartbeat-runner-execution.js";
import { resolveHeartbeatRunPrompt } from "../infra/heartbeat-runner-prompt.js";
import { startHeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { resolveHeartbeatWakePayloadFlags } from "../infra/heartbeat-wake-policy.js";
import { requestHeartbeat as requestHeartbeatWake } from "../infra/heartbeat-wake.js";
import {
  drainSystemEvents,
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-failure-notification-",
  baseTimeIso: "2026-01-01T00:00:00.000Z",
});

describe("CronService failure notification delivery", () => {
  it.each([
    {
      name: "the explicitly targeted Telegram topic",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      sessionTarget: "session:agent:ops:telegram:group:42:topic:77" as const,
      wakeMode: "now" as const,
      carriesOrigin: true,
      wakesNow: true,
    },
    {
      name: "a persistent target instead of its creation conversation",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      creationSessionKey: "agent:ops:discord:channel:other",
      sessionTarget: "session:agent:ops:telegram:group:42:topic:77" as const,
      wakeMode: "now" as const,
      carriesOrigin: true,
      wakesNow: true,
    },
    {
      name: "a targeted next-heartbeat conversation immediately",
      agentId: "ops",
      sessionKey: "agent:ops:telegram:group:42:topic:77",
      creationSessionKey: "agent:ops:telegram:group:42:topic:77",
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      carriesOrigin: true,
      wakesNow: true,
    },
    {
      name: "the default owner without exposing its last group",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      carriesOrigin: false,
      wakesNow: true,
    },
    {
      name: "an untargeted next-heartbeat conversation without waking it",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionTarget: "isolated" as const,
      wakeMode: "next-heartbeat" as const,
      carriesOrigin: false,
      wakesNow: false,
    },
  ])("routes a rejected failure alert to $name with cadence disabled", async (testCase) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "0m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    };
    const deliveryContext: DeliveryContext = {
      channel: "telegram",
      to: "-10042",
      threadId: 77,
    };
    const observed: Array<{ prompt: string; deliveryContext?: DeliveryContext }> = [];
    const runOnce = vi.fn(async (options: HeartbeatRunOptions) => {
      const pendingEventEntries = peekSystemEventEntries(options.sessionKey ?? "");
      const preflight = {
        ...resolveHeartbeatWakePayloadFlags(options),
        session: {
          sessionKey: testCase.sessionKey,
          storePath: "/tmp/cron-failure-alert-notification-proof.json",
          suppressOriginatingContext: false,
          entry: undefined,
        },
        pendingEventEntries,
        turnSourceDeliveryContext: pendingEventEntries[0]?.deliveryContext,
        hasTaggedCronEvents: pendingEventEntries.some((event) =>
          event.contextKey?.startsWith("cron:"),
        ),
        shouldInspectPendingEvents: true,
        authoritativeScheduledTick: false,
      };
      observed.push({
        prompt: resolveHeartbeatRunPrompt({
          cfg,
          preflight,
          canRelayToUser: true,
          startedAt: Date.now(),
          scheduledTasks: [],
          useHeartbeatResponseTool: false,
        }).prompt,
        deliveryContext: pendingEventEntries[0]?.deliveryContext,
      });
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startHeartbeatRunner({ cfg, readCurrentConfig: () => cfg, runOnce });
    const store = await makeStorePath();
    const resolveOriginDeliveryContext = vi.fn(() => deliveryContext);
    const sendCronFailureAlert = vi.fn(async (params) => {
      await params.onDeliverySettled({
        delivered: false,
        status: "not-delivered",
        error: "failure alert channel unavailable",
      });
      throw new Error("failure alert channel unavailable");
    });
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      defaultAgentId: "main",
      log: logger,
      resolveOriginDeliveryContext,
      enqueueSystemEvent: (text, options) =>
        enqueueSystemEvent(text, {
          sessionKey:
            options?.sessionKey ??
            resolveAgentMainSessionKey({ cfg, agentId: options?.agentId ?? "main" }),
          contextKey: options?.contextKey,
          deliveryContext: options?.deliveryContext,
        }),
      requestHeartbeat: (wake) =>
        requestHeartbeatWake({
          ...wake,
          sessionKey:
            wake.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId: wake.agentId ?? "main" }),
          coalesceMs: 0,
        }),
      sendCronFailureAlert,
      runIsolatedAgentJob: async () => ({
        status: "error",
        error: "temporary upstream error",
      }),
    });
    try {
      await cron.start();
      const job = await cron.add({
        name: "Important report",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: testCase.sessionTarget,
        ...("creationSessionKey" in testCase ? { sessionKey: testCase.creationSessionKey } : {}),
        wakeMode: testCase.wakeMode,
        payload: { kind: "agentTurn", message: "run report" },
      });

      await cron.run(job.id, "force");
      await vi.advanceTimersByTimeAsync(1);

      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(peekSystemEventEntries(testCase.sessionKey)).toHaveLength(1);
      expect(runOnce).toHaveBeenCalledTimes(testCase.wakesNow ? 1 : 0);
      if (testCase.wakesNow) {
        expect(runOnce).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: testCase.agentId,
            sessionKey: testCase.sessionKey,
            source: "notifications-event",
            intent: "immediate",
            reason: "wake",
          }),
        );
        expect(observed[0]?.prompt).toContain('Automation "Important report" failed 1 times');
        expect(observed[0]?.prompt).toContain("Please relay this reminder to the user");
        expect(observed[0]?.deliveryContext).toEqual(
          testCase.carriesOrigin ? deliveryContext : undefined,
        );
      }
      if (testCase.carriesOrigin) {
        expect(resolveOriginDeliveryContext).toHaveBeenCalledOnce();
      } else {
        expect(resolveOriginDeliveryContext).not.toHaveBeenCalled();
      }
    } finally {
      cron.stop();
      runner.stop();
      drainSystemEvents(testCase.sessionKey);
    }
  });
});
