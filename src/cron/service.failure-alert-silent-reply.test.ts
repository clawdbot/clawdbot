import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveConfiguredModelRefMock,
  resolveCronPayloadOutcomeMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

type CronServiceParams = ConstructorParameters<typeof CronService>[0];
type SendCronFailureAlertParams = Parameters<
  NonNullable<CronServiceParams["sendCronFailureAlert"]>
>[0];

describe.sequential("CronService silent failure alerts", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
  });

  it("persists a tool failure and emits the configured operator alert", async () => {
    const { resolveCronPayloadOutcome } = await vi.importActual<
      typeof import("./isolated-agent/helpers.js")
    >("./isolated-agent/helpers.js");
    resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    const modelRef = { provider: "openai", model: "gpt-5.4" };
    resolveConfiguredModelRefMock.mockReturnValue(modelRef);
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "⚠️ 🛠️ Bash failed: mount unavailable", isError: true }],
      meta: { agentMeta: {}, finalAssistantVisibleText: "NO_REPLY" },
    });

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-silent-failure-" },
      async (state) => {
        resetTaskRegistryForTests();
        const sendCronFailureAlert = vi.fn(
          async (_params: SendCronFailureAlertParams) => undefined,
        );
        const storePath = state.path("cron", "jobs.json");
        const cron = new CronService({
          storePath,
          cronEnabled: true,
          cronConfig: {
            triggers: { enabled: true },
            failureAlert: { enabled: true, after: 1, cooldownMs: 0 },
          },
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          sendCronFailureAlert,
          runIsolatedAgentJob: async (runParams) =>
            await runCronIsolatedAgentTurn({
              ...runParams,
              cfg: { agents: { defaults: { model: `${modelRef.provider}/${modelRef.model}` } } },
              deps: {},
              sessionKey: `cron:${runParams.job.id}`,
            }),
        });
        try {
          await cron.start();
          const job = await cron.add({
            name: "mount check",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: {
              kind: "agentTurn",
              message: "check mount",
              model: `${modelRef.provider}/${modelRef.model}`,
            },
            delivery: { mode: "none" },
          });

          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

          const persisted = (await loadCronStore(storePath)).jobs.find(
            (candidate) => candidate.id === job.id,
          );
          expect(persisted?.state.lastRunStatus).toBe("error");
          expect(persisted?.state.lastError).toContain("Bash failed");
          expect(persisted?.state.consecutiveErrors).toBe(1);
          expect(persisted?.state.lastFailureAlertAtMs).toBeDefined();
          expect(sendCronFailureAlert).toHaveBeenCalledOnce();
          expect(sendCronFailureAlert.mock.calls[0]?.[0].payload.text).toContain(
            'Automation "mount check" failed 1 times',
          );
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });
});
