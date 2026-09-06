import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentDeleteDatabases } from "../../agents/agent-delete-databases.js";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { digestClawAgentConfig } from "../../claws/agent-config-digest.js";
import { clawCronGatewayJobMatchesRef, readClawCronRefs } from "../../claws/cron.js";
import { readAttachedCronJobs } from "../../claws/lifecycle-delete-support.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import {
  clawMonitorCleanupBindingSchema,
  clawMonitorSnapshotSchema,
  type ClawMonitorSnapshot,
} from "../../claws/monitor-cleanup-contract.js";
import { readClawInstallRecord } from "../../claws/provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasActiveCronJobsForAgent } from "../../cron/active-jobs.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { resolveHeartbeatMonitorPlan } from "../../cron/heartbeat-monitor.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { getSuspensionVisibleCronTaskRunCount } from "../../cron/service/active-run-cancellation.js";
import { reconcileToolsAllowAuthority } from "../../cron/service/jobs-tool-policy.js";
import { hasPendingCronSessionCleanupForAgent } from "../../cron/service/locked.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "../../cron/skill-collection-review-monitor.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { hasActiveCronRunReceiptsForAgent } from "../../cron/store/run-receipt-drain.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

type ClawMonitorContext = Pick<
  GatewayRequestContext,
  "cron" | "cronStorePath" | "getRuntimeConfig" | "isConfigReloadSettled"
>;

const text = z.string().min(1).max(4096);
const target = { agentId: text, binding: clawMonitorCleanupBindingSchema };
const paramsSchema = z.discriminatedUnion("phase", [
  z.object({ ...target, phase: z.literal("inspect") }).strict(),
  z
    .object({
      phase: z.literal("quiesce"),
      ...target,
      operationId: text,
      monitors: z.array(clawMonitorSnapshotSchema).max(2),
    })
    .strict(),
  z.object({ ...target, phase: z.literal("drain"), operationId: text }).strict(),
]);

function desiredMonitorRevision(input: CronJobCreate, existing: CronJob): string {
  const desired: CronJob = {
    ...input,
    id: existing.id,
    createdAtMs: existing.createdAtMs,
    updatedAtMs: 0,
    enabled: input.enabled ?? true,
    state: {},
  };
  // Apply creation's authority defaults without inheriting the row's policy.
  reconcileToolsAllowAuthority({
    job: desired,
    previouslyUsedToolRuntime: false,
    explicitlyMutatesToolsAllow: true,
  });
  return resolveCronJobConfigRevision(desired);
}

function inspectMonitors(
  context: ClawMonitorContext,
  agentId: string,
  jobs: readonly CronJob[],
): ClawMonitorSnapshot[] {
  const cfg = context.getRuntimeConfig();
  const specs = [
    ...resolveHeartbeatMonitorPlan(cfg, jobs).specs,
    ...resolveSkillCollectionReviewMonitorSpecs(cfg),
  ].filter((spec) => spec.agentId === agentId);
  const storeKey = cronStoreKey(context.cronStorePath);
  return readAttachedCronJobs(agentId, {}).flatMap((row) => {
    if (
      row.storeKey !== storeKey ||
      row.agentId !== agentId ||
      row.ownerAgentId !== null ||
      !row.declarationKey ||
      !row.revision
    ) {
      return [];
    }
    const matchingJobs = jobs.filter((job) => job.declarationKey === row.declarationKey);
    const job = matchingJobs.length === 1 ? matchingJobs[0] : undefined;
    const spec = specs.find((entry) => entry.input.declarationKey === row.declarationKey)?.input;
    if (
      !job ||
      !spec ||
      job.id !== row.id ||
      job.agentId !== agentId ||
      job.owner ||
      resolveCronJobConfigRevision(job) !== row.revision ||
      desiredMonitorRevision(spec, job) !== row.revision
    ) {
      return [];
    }
    return [
      {
        ...row,
        agentId,
        ownerAgentId: null,
        declarationKey: row.declarationKey,
        revision: row.revision,
      },
    ];
  });
}

function assertDeletionFence(agentId: string, operationId: string, config: OpenClawConfig) {
  const journal = readAgentDeletionJournal(agentId);
  const install = readClawInstallRecord(agentId);
  if (!journal || journal.operationId !== operationId || journal.cleanupCompleted) {
    throw new Error("Claw removal no longer owns the serving Gateway's deletion fence.");
  }
  // Orphaned ownership can outlive its install row, but must never remove a configured replacement.
  const agent = listAgentEntries(config).find((entry) => entry.id === agentId);
  if (agent && digestClawAgentConfig(agent) !== install?.agentConfigDigest) {
    throw new Error("The serving Gateway's Claw agent configuration changed after planning.");
  }
  return journal;
}

function isDrained(context: ClawMonitorContext, agentId: string, requireConfigRemoval: boolean) {
  return (
    (!requireConfigRemoval ||
      (context.isConfigReloadSettled() &&
        !listAgentEntries(context.getRuntimeConfig()).some((agent) => agent.id === agentId))) &&
    !hasActiveCronJobsForAgent(agentId) &&
    getSuspensionVisibleCronTaskRunCount({ agentId }) === 0 &&
    !hasPendingCronSessionCleanupForAgent(agentId) &&
    !hasActiveCronRunReceiptsForAgent(agentId) &&
    (!requireConfigRemoval || readAttachedCronJobs(agentId, {}).length === 0)
  );
}

async function waitForDrain(
  context: ClawMonitorContext,
  agentId: string,
  requireConfigRemoval: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  do {
    assertCurrent();
    if (isDrained(context, agentId, requireConfigRemoval)) {
      return;
    }
    await sleep(50);
  } while (performance.now() < deadline);
  throw new Error(
    "Gateway monitor cancellation, run drainage, or config convergence is incomplete; preview and retry Claw removal.",
  );
}

export const clawsMonitorHandlers = {
  "claws.monitors": async ({
    params,
    respond,
    context,
  }: {
    params: Record<string, unknown>;
    respond: RespondFn;
    context: ClawMonitorContext;
  }) => {
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw monitor cleanup parameters."),
      );
      return;
    }
    const input = parsed.data;
    try {
      const cron = context.cron;
      const assertBinding = () => {
        if (
          !isDeepStrictEqual(input.binding, resolveClawMonitorCleanupBinding(context.cronStorePath))
        ) {
          throw new Error("Gateway does not serve this Claw's config and scheduler state.");
        }
        if (
          input.phase !== "drain" &&
          (context.cron !== cron || !context.isConfigReloadSettled())
        ) {
          throw new Error("Gateway scheduler or configuration is changing; retry Claw removal.");
        }
      };
      assertBinding();
      if (input.phase === "inspect") {
        const jobs = await cron.list({ includeDisabled: true });
        assertBinding();
        respond(true, { monitors: inspectMonitors(context, input.agentId, jobs) }, undefined);
        return;
      }
      const assertCurrent = () => {
        assertBinding();
        return assertDeletionFence(input.agentId, input.operationId, context.getRuntimeConfig());
      };
      assertCurrent();
      if (input.phase === "quiesce") {
        const jobs = await cron.list({ includeDisabled: true });
        assertCurrent();
        const monitors = inspectMonitors(context, input.agentId, jobs);
        if (!isDeepStrictEqual(monitors, input.monitors)) {
          throw new Error("Config-owned monitors changed after removal planning.");
        }
        const refs = readClawCronRefs(input.agentId);
        const attached = readAttachedCronJobs(input.agentId, {});
        const allowed = attached.map((row) => {
          const job = jobs.find((candidate) => candidate.id === row.id);
          if (
            !job ||
            !row.revision ||
            row.storeKey !== cronStoreKey(context.cronStorePath) ||
            resolveCronJobConfigRevision(job) !== row.revision ||
            (!monitors.some((monitor) => isDeepStrictEqual(monitor, row)) &&
              !refs.some(
                (ref) =>
                  ref.status === "complete" &&
                  ref.schedulerJobId === row.id &&
                  clawCronGatewayJobMatchesRef(input.agentId, ref, cronJobReadView(job)),
              ))
          ) {
            throw new Error(
              `Independent or changed cron job ${row.id} still references the Claw agent.`,
            );
          }
          return { id: row.id, revision: row.revision };
        });
        await cron.quiesceJobs(allowed, () => {
          assertCurrent();
          if (
            !isDeepStrictEqual(readAttachedCronJobs(input.agentId, {}), attached) ||
            !isDeepStrictEqual(readClawCronRefs(input.agentId), refs)
          ) {
            throw new Error("Attached scheduled work changed before monitor cancellation.");
          }
        });
      }
      await waitForDrain(context, input.agentId, input.phase === "drain", assertCurrent);
      const journal = assertCurrent();
      if (!isDrained(context, input.agentId, input.phase === "drain")) {
        throw new Error(
          "Gateway cleanup state changed before drainage was acknowledged; retry Claw removal.",
        );
      }
      if (input.phase === "quiesce") {
        prepareAgentDeleteDatabases(context.getRuntimeConfig(), input.agentId, journal.agentDir);
      }
      respond(true, { drained: true }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
      );
    }
  },
} satisfies GatewayRequestHandlers;
