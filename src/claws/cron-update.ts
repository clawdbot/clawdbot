import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayJobMatchesRef,
  clawCronGatewayInput,
  clawCronSchedulerJobFromResult,
  deleteClawCronRef,
  readClawCronRefs,
  upsertClawCronRef,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import type { ClawCronJob, ClawManifest } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";

export type ClawCronUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
};

export class ClawCronUpdateError extends Error {
  constructor(
    message: string,
    readonly partial = false,
  ) {
    super(message);
    this.name = "ClawCronUpdateError";
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function targetRef(params: {
  agentId: string;
  job: ClawCronJob;
  schedulerJobId?: string;
  previous?: PersistedClawCronRef;
  nowMs: number;
}): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: params.agentId,
    manifestId: params.job.id,
    declarationKey: `claw:${params.agentId}:${params.job.id}`,
    ...(params.schedulerJobId ? { schedulerJobId: params.schedulerJobId } : {}),
    status: "pending",
    job: params.job,
    createdAtMs: params.previous?.createdAtMs ?? params.nowMs,
    updatedAtMs: params.nowMs,
  };
}

export async function applyClawCronUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  options: OpenClawStateDatabaseOptions & {
    cronGateway?: ClawCronGateway;
    nowMs?: number;
    readRefs?: typeof readClawCronRefs;
    upsertRef?: typeof upsertClawCronRef;
    deleteRef?: typeof deleteClawCronRef;
  },
): Promise<ClawCronUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "cronJob" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedIds: [], rollback: async () => undefined };
  }
  if (!options.cronGateway) {
    throw new ClawCronUpdateError("Claw cron updates require the gateway cron API.");
  }
  if (!options.cronGateway.get) {
    throw new ClawCronUpdateError("Claw cron updates require the gateway cron.get API.");
  }
  const gateway = options.cronGateway;
  const readRefs = options.readRefs ?? readClawCronRefs;
  const upsertRef = options.upsertRef ?? upsertClawCronRef;
  const deleteRef = options.deleteRef ?? deleteClawCronRef;
  const currentRefs = new Map(
    readRefs(updatePlan.agentId, options).map((ref) => [ref.manifestId, ref]),
  );
  const targetJobs = new Map(targetManifest.cronJobs.map((job) => [job.id, job]));
  const undo: Array<() => Promise<void>> = [];
  const appliedIds: string[] = [];
  const nowMs = options.nowMs ?? Date.now();

  const add = async (ref: PersistedClawCronRef): Promise<string> => {
    let raw: unknown;
    try {
      raw = await gateway.add(clawCronGatewayInput(updatePlan.agentId, ref));
    } catch (error) {
      throw new ClawCronUpdateError(error instanceof Error ? error.message : String(error), true);
    }
    const result = clawCronSchedulerJobFromResult(raw);
    if (!result) {
      throw new ClawCronUpdateError("cron.add returned no scheduler job id.", true);
    }
    return result.id;
  };
  const rollback = async () => {
    const failures: string[] = [];
    for (const revert of undo.toReversed()) {
      try {
        await revert();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length > 0) {
      throw new ClawCronUpdateError(failures.join("; "));
    }
  };

  try {
    for (const action of actions) {
      const previous = currentRefs.get(action.id);
      if (previous && action.currentDigest && digest(previous.job) !== action.currentDigest) {
        throw new ClawCronUpdateError(
          `Cron declaration ${JSON.stringify(action.id)} changed after planning.`,
        );
      }
      if (previous?.schedulerJobId) {
        const live = await gateway.get!(previous.schedulerJobId);
        if (!clawCronGatewayJobMatchesRef(updatePlan.agentId, previous, live)) {
          throw new ClawCronUpdateError(
            `Cron declaration ${JSON.stringify(action.id)} changed after planning.`,
          );
        }
      }
      if (action.action === "remove") {
        if (!previous?.schedulerJobId || previous.status !== "complete") {
          throw new ClawCronUpdateError(
            `Cron declaration ${JSON.stringify(action.id)} is no longer safely removable.`,
          );
        }
        upsertRef({ ...previous, status: "pending", updatedAtMs: nowMs }, options);
        try {
          await gateway.remove(previous.schedulerJobId);
        } catch (error) {
          throw new ClawCronUpdateError(
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
        undo.push(async () => {
          const restoredId = await add(previous);
          upsertRef({ ...previous, schedulerJobId: restoredId, updatedAtMs: nowMs }, options);
        });
        deleteRef(updatePlan.agentId, action.id, options);
        appliedIds.push(action.id);
        continue;
      }

      const job = targetJobs.get(action.id);
      if (!job) {
        throw new ClawCronUpdateError(
          `Target cron declaration ${JSON.stringify(action.id)} is missing.`,
        );
      }
      const pending = targetRef({ agentId: updatePlan.agentId, job, previous, nowMs });
      upsertRef(pending, options);
      const schedulerJobId = await add(pending);
      if (action.action === "change") {
        if (!previous?.schedulerJobId || schedulerJobId !== previous.schedulerJobId) {
          try {
            await gateway.remove(schedulerJobId);
            if (previous) {
              upsertRef(previous, options);
            }
          } catch (error) {
            throw new ClawCronUpdateError(
              `cron.add did not converge and cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
          }
          throw new ClawCronUpdateError(
            `cron.add did not converge declaration ${JSON.stringify(action.id)} on its owned scheduler job.`,
          );
        }
        undo.push(async () => {
          const restoredId = await add(previous);
          upsertRef({ ...previous, schedulerJobId: restoredId, updatedAtMs: nowMs }, options);
        });
      } else {
        undo.push(async () => {
          await gateway.remove(schedulerJobId);
          deleteRef(updatePlan.agentId, action.id, options);
        });
      }
      upsertRef({ ...pending, schedulerJobId, status: "complete" }, options);
      appliedIds.push(action.id);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawCronUpdateError(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        true,
      );
    }
    throw new ClawCronUpdateError(
      error instanceof Error ? error.message : String(error),
      error instanceof ClawCronUpdateError && error.partial,
    );
  }
  return { appliedIds, rollback };
}
