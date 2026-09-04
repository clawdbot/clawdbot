import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { hasActiveCronJobs } from "../../cron/active-jobs.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { setupCronServiceSuite } from "../../cron/service.test-harness.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-self-removal-" });

describe.each(["manual", "timer"] as const)("cron self-removal through %s execution", (path) => {
  it.each([60, 0])("finishes its current run with timeoutSeconds=%s", async (timeoutSeconds) => {
    const { storePath } = await makeStorePath();
    const events: CronEvent[] = [];
    let abortedAfterRemoval: boolean | undefined;
    let activeAfterRemoval: boolean | undefined;
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent: (event) => events.push(event),
      runIsolatedAgentJob: async ({ job, abortSignal, executionIdentity }) => {
        const admission = prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef(`run-${job.id}`),
          facts: {
            runId: `run-${job.id}`,
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
        try {
          const admitted = await admission.admit("embedded");
          executionIdentity?.onPostAdmission?.(admitted);
          const delegatedAuthority = expectDefined(
            getAdmittedRunDelegatedAuthority(admitted),
            "live scheduled admission",
          );
          const client: GatewayClient = {
            connect: {} as GatewayClient["connect"],
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey: `agent:main:cron:${job.id}`,
                operationalRunInstance: admitted.operationalRunInstance,
                delegatedAuthority: { kind: "local", ...delegatedAuthority },
                cronSelfManagementContext: { jobId: job.id, expiresAtMs: Date.now() + 60_000 },
              },
            },
          };
          const respond = vi.fn<RespondFn>();
          const params = { id: job.id };
          await expectDefined(
            cronHandlers["cron.remove"],
            "cron.remove",
          )({
            req: { type: "req", id: "self-remove", method: "cron.remove", params },
            params,
            client,
            respond,
            context: createDirectChatContext({
              cron,
              cronStorePath: storePath,
              validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
            }),
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledWith(true, { ok: true, removed: true }, undefined);
          abortedAfterRemoval = abortSignal?.aborted;
          activeAfterRemoval = hasActiveCronJobs();
          return { status: "ok", summary: "final reply after self-cleanup" };
        } finally {
          admission.close();
        }
      },
    });
    try {
      const job = await cron.add(
        {
          name: "self-cleanup",
          enabled: true,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 1_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "remove this job, then finish", timeoutSeconds },
          delivery: { mode: "none" },
        },
        { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      );
      if (path === "manual") {
        await cron.run(job.id, "force");
      } else {
        await cron.start();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({
          jobId: job.id,
          status: "ok",
          completionStatus: "succeeded",
          summary: "final reply after self-cleanup",
        }),
      ]);
      expect(abortedAfterRemoval).toBe(false);
      expect(activeAfterRemoval).toBe(true);
      expect(hasActiveCronJobs()).toBe(false);
      expect(await cron.readJob(job.id)).toBeUndefined();
    } finally {
      cron.stop();
    }
  });
});
