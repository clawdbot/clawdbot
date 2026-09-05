import { describe, expect, it, vi } from "vitest";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HeartbeatRunOptions } from "../../infra/heartbeat-runner-execution.js";
import {
  resolveHeartbeatPreflight,
  resolveHeartbeatRunPrompt,
} from "../../infra/heartbeat-runner-prompt.js";
import { startHeartbeatRunner } from "../../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeat as requestHeartbeatWake } from "../../infra/heartbeat-wake.js";
import {
  drainSystemEvents,
  enqueueSystemEvent as queueSystemEvent,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

describe("cron script immediate wake", () => {
  it.each([
    {
      name: "main-session notification",
      sessionTarget: "main",
      notify: "The deployment queue needs attention.",
      expectedText: "The deployment queue needs attention.",
      contextKey: "cron:script-job:script",
      wake: "now",
      immediate: true,
    },
    {
      name: "isolated wake-only completion",
      sessionTarget: "isolated",
      expectedText: "script job script job completed",
      contextKey: "cron:script-job:script-wake",
      wake: "now",
      immediate: true,
    },
    {
      name: "deferred main-session notification",
      sessionTarget: "main",
      notify: "Keep this reminder for the next heartbeat.",
      expectedText: "Keep this reminder for the next heartbeat.",
      contextKey: "cron:script-job:script",
      wake: "next-heartbeat",
      immediate: false,
    },
  ] as const)(
    "honors a $name when recurring heartbeat cadence is disabled",
    async ({ sessionTarget, expectedText, contextKey, wake, immediate, ...result }) => {
      vi.useFakeTimers();
      const now = Date.parse("2026-08-24T12:00:00.000Z");
      vi.setSystemTime(now);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { heartbeat: { every: "0m" } },
          list: [{ id: "main" }, { id: "finn" }],
        },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "finn" });
      const prompts: string[] = [];
      const runOnce = vi.fn(async (options: HeartbeatRunOptions) => {
        const prompt = resolveHeartbeatRunPrompt({
          cfg,
          preflight: await resolveHeartbeatPreflight({
            cfg,
            agentId: "finn",
            sessionKey: options.sessionKey,
            heartbeat: options.heartbeat,
            source: options.source,
            reason: options.reason,
          }),
          canRelayToUser: true,
          startedAt: now,
          scheduledTasks: [],
          useHeartbeatResponseTool: false,
        });
        expect(prompt.hasCronEvents).toBe(true);
        prompts.push(prompt.prompt);
        return { status: "ran" as const, durationMs: 1 };
      });
      const runner = startHeartbeatRunner({
        cfg,
        readCurrentConfig: () => cfg,
        runOnce,
      });

      try {
        const state = createCronServiceState({
          storePath: "/tmp/cron-script-wake-state.sqlite",
          cronEnabled: true,
          cronConfig: { triggers: { enabled: true } },
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          nowMs: () => now,
          enqueueSystemEvent: (text, options) =>
            queueSystemEvent(text, {
              sessionKey,
              contextKey: options?.contextKey,
              deliveryContext: options?.deliveryContext,
            }),
          requestHeartbeat: (wakeRequest) =>
            requestHeartbeatWake({ ...wakeRequest, sessionKey, coalesceMs: 0 }),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runScriptJob: vi.fn(async () => ({
            status: "ok" as const,
            ...("notify" in result ? { notify: result.notify } : {}),
            wake,
          })),
        });
        const job: CronJob = {
          id: "script-job",
          name: "script job",
          agentId: "finn",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
          sessionTarget,
          wakeMode: "now",
          payload: { kind: "script", script: "return { wake: 'now' }" },
          state: {},
        };

        await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
        expect(peekSystemEventEntries(sessionKey)).toEqual([
          expect.objectContaining({ text: expectedText, contextKey }),
        ]);

        await vi.advanceTimersByTimeAsync(1);

        if (!immediate) {
          expect(runOnce).not.toHaveBeenCalled();
          expect(peekSystemEventEntries(sessionKey)).toEqual([
            expect.objectContaining({ text: expectedText, contextKey }),
          ]);
          return;
        }

        expect(runOnce).toHaveBeenCalledOnce();
        expect(runOnce).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "finn",
            sessionKey,
            source: "notifications-event",
            intent: "immediate",
            reason: "wake",
          }),
        );
        expect(prompts[0]).toContain(expectedText);
        expect(prompts[0]).toContain("Please relay this reminder to the user");
      } finally {
        runner.stop();
        drainSystemEvents(sessionKey);
        vi.useRealTimers();
      }
    },
  );
});
