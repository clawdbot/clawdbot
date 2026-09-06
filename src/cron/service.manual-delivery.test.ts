import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { dispatchCronDelivery } from "./isolated-agent/delivery-dispatch.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronEvent } from "./service/state.js";

const FOUR_HOURS_MS = 4 * 60 * 60_000;

describe("manual cron delivery occurrence", () => {
  it.each([
    { label: "direct force", mode: "force", queued: false },
    { label: "queued force", mode: "force", queued: true },
    { label: "scheduled due", mode: "due", queued: false },
  ] as const)(
    "delivers according to the $label occurrence after the scheduled slot ages",
    async ({ mode, queued }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-manual-delivery-" },
        async (state) => {
          const registry = captureActivePluginRegistrySnapshot();
          const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "fresh-result" }));
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "telegram",
                source: "test",
                plugin: createOutboundTestPlugin({
                  id: "telegram",
                  outbound: { deliveryMode: "direct", sendText },
                }),
              },
            ]),
          );
          resetTaskRegistryForTests({ persist: false });
          let now = Date.now() - FOUR_HOURS_MS;
          const cfg: OpenClawConfig = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
          };
          await state.writeConfig(cfg);
          const events: CronEvent[] = [];
          const cron = new CronService({
            storePath: state.path("cron", "jobs.json"),
            cronEnabled: false,
            defaultAgentId: "main",
            nowMs: () => now,
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            onEvent: (event) => events.push(event),
            runIsolatedAgentJob: async ({ job, abortSignal }) => {
              const text = "Fresh result from this invocation.";
              const sessionKey = `agent:main:cron:${job.id}`;
              const delivery = await dispatchCronDelivery({
                cfg,
                cfgWithAgentDefaults: cfg,
                deps: {},
                job,
                agentId: "main",
                agentSessionKey: sessionKey,
                runSessionKey: sessionKey,
                sessionId: "manual-delivery-run",
                lifecycleRevision: "manual-delivery-revision",
                sessionUpdatedAt: now,
                runStartedAt: now,
                runEndedAt: now,
                timeoutMs: 30_000,
                resolvedDelivery: { ok: true, channel: "telegram", to: "123", mode: "explicit" },
                deliveryRequested: true,
                deliveryPlan: resolveCronDeliveryPlan(job),
                undeliveredRunStatus: "ok",
                spawnOnlyHandoff: false,
                sourceDeliveryOutcome: {
                  visibleDeliveries: [],
                  verifiedMessageToolDelivery: false,
                  satisfiesSourceDelivery: false,
                  unverifiedMessageToolDelivery: false,
                },
                deliveryBestEffort: false,
                deliveryPayloadHasStructuredContent: false,
                deliveryPayloads: [{ text }],
                synthesizedText: text,
                summary: text,
                outputText: text,
                abortSignal,
                isAborted: () => abortSignal?.aborted === true,
                abortReason: () => "aborted",
                withRunSession: (result) => ({
                  ...result,
                  sessionId: "manual-delivery-run",
                  sessionKey,
                }),
              });
              return { status: "ok", ...delivery.result, ...delivery };
            },
          });
          try {
            await cron.start();
            const job = await cron.add({
              name: "fresh manual result",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Produce a fresh report." },
              delivery: { mode: "announce", channel: "telegram", to: "123" },
            });
            const scheduledAt = job.state.nextRunAtMs;
            now += FOUR_HOURS_MS;
            if (queued) {
              await expect(cron.enqueueRun(job.id, mode)).resolves.toMatchObject({
                ok: true,
                enqueued: true,
              });
              await vi.waitFor(() => {
                expect(events.some((event) => event.action === "finished")).toBe(true);
              });
              await cron.status();
            } else {
              await expect(cron.run(job.id, mode)).resolves.toMatchObject({ ok: true, ran: true });
            }
            expect(sendText).toHaveBeenCalledTimes(mode === "force" ? 1 : 0);
            expect(events.find((event) => event.action === "finished")).toMatchObject({
              status: "ok",
              completionStatus: mode === "force" ? "succeeded" : "failed",
              deliveryStatus: mode === "force" ? "delivered" : "not-delivered",
            });
            if (mode === "force") {
              expect(sendText).toHaveBeenCalledWith(
                expect.objectContaining({ text: "Fresh result from this invocation." }),
              );
              expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(scheduledAt);
              expect(cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
            }
          } finally {
            cron.stop();
            resetTaskRegistryForTests({ persist: false });
            restoreActivePluginRegistrySnapshot(registry);
          }
        },
      );
    },
  );
});
