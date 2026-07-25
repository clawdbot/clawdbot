import type { CronSchedulerReadinessSnapshot } from "../cron/service-contract.js";
import { getSessionDeliveryRuntimeReadiness } from "../infra/session-delivery-runtime-readiness.js";
import { getOpenClawStateDatabaseReadiness } from "../state/openclaw-state-db-readiness.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { ReadinessCondition } from "./conditions.js";
import { CORE_READINESS_SUBJECT_REFS, type ReadinessSubject } from "./subjects.js";

export const STATE_READY_CRITERION_ID = "openclaw.state-ready";
export const DELIVERY_RUNTIME_READY_CRITERION_ID = "openclaw.delivery-runtime-ready";
export const SCHEDULER_READY_CRITERION_ID = "openclaw.scheduler-ready";

export type StateServiceReadinessSnapshot = {
  scheduler?: CronSchedulerReadinessSnapshot;
};

type StateServiceReadinessDeps = {
  getStateDatabaseStatus: typeof getOpenClawStateDatabaseReadiness;
  getDeliveryRuntime: typeof getSessionDeliveryRuntimeReadiness;
};

const defaultDeps: StateServiceReadinessDeps = {
  getStateDatabaseStatus: getOpenClawStateDatabaseReadiness,
  getDeliveryRuntime: getSessionDeliveryRuntimeReadiness,
};

function condition(
  type: string,
  status: ReadinessCondition["status"],
  reason: string,
  message: string,
): ReadinessCondition {
  const refs: Record<string, string> = {
    StateReady: CORE_READINESS_SUBJECT_REFS.stateDatabase,
    DeliveryRuntimeReady: CORE_READINESS_SUBJECT_REFS.deliveryRuntime,
    SchedulerReady: CORE_READINESS_SUBJECT_REFS.scheduler,
  };
  const subjectRef = refs[type];
  if (!subjectRef) {
    throw new Error(`unknown state readiness condition: ${type}`);
  }
  return { type, subjectRef, status, requirement: "advisory", reason, message };
}

export function listStateServiceReadinessSubjects(): ReadinessSubject[] {
  return [
    { ref: CORE_READINESS_SUBJECT_REFS.stateDatabase, kind: "openclaw.state-database" },
    { ref: CORE_READINESS_SUBJECT_REFS.deliveryRuntime, kind: "openclaw.delivery-runtime" },
    { ref: CORE_READINESS_SUBJECT_REFS.scheduler, kind: "openclaw.scheduler" },
  ];
}

function unknown(type: string): ReadinessCondition {
  return condition(
    type,
    "Unknown",
    "CriterionEvaluationFailed",
    `${type} readiness evidence is unavailable.`,
  );
}

export function createStateServiceReadinessResolver(deps: StateServiceReadinessDeps = defaultDeps) {
  return (params: {
    criterionIds: ReadonlySet<string>;
    env?: NodeJS.ProcessEnv;
    snapshot?: StateServiceReadinessSnapshot;
  }): ReadinessCondition[] => {
    const conditions: ReadinessCondition[] = [];

    if (params.criterionIds.has(STATE_READY_CRITERION_ID)) {
      try {
        const status = deps.getStateDatabaseStatus(
          resolveOpenClawStateSqlitePath(params.env ?? process.env),
        );
        conditions.push(
          status === "active"
            ? condition(
                "StateReady",
                "True",
                "StateDatabaseReady",
                "Shared state database is active.",
              )
            : condition(
                "StateReady",
                "False",
                status === "failed" ? "StateDatabaseUnavailable" : "StateDatabaseInactive",
                status === "failed"
                  ? "Shared state database activation failed."
                  : "Shared state database is not active.",
              ),
        );
      } catch {
        conditions.push(unknown("StateReady"));
      }
    }

    if (params.criterionIds.has(DELIVERY_RUNTIME_READY_CRITERION_ID)) {
      try {
        const delivery = deps.getDeliveryRuntime();
        conditions.push(
          delivery.active
            ? condition(
                "DeliveryRuntimeReady",
                "True",
                "DeliveryRuntimeReady",
                "Durable session delivery runtime is active.",
              )
            : condition(
                "DeliveryRuntimeReady",
                "False",
                "DeliveryRuntimeInactive",
                "Durable session delivery runtime is not active.",
              ),
        );
      } catch {
        conditions.push(unknown("DeliveryRuntimeReady"));
      }
    }

    if (params.criterionIds.has(SCHEDULER_READY_CRITERION_ID)) {
      const scheduler = params.snapshot?.scheduler;
      if (!scheduler) {
        conditions.push(
          condition(
            "SchedulerReady",
            "Unknown",
            "SchedulerStatusUnavailable",
            "Scheduler lifecycle evidence is unavailable.",
          ),
        );
      } else if (!scheduler.enabled || scheduler.phase === "disabled") {
        conditions.push(
          condition(
            "SchedulerReady",
            "True",
            "SchedulerNotConfigured",
            "Scheduler is disabled by configuration.",
          ),
        );
      } else if (scheduler.recoveryPending) {
        conditions.push(
          condition(
            "SchedulerReady",
            "False",
            "SchedulerRecoveryPending",
            "Scheduler startup recovery is still pending.",
          ),
        );
      } else if (scheduler.phase === "started") {
        conditions.push(
          condition("SchedulerReady", "True", "SchedulerReady", "Scheduler is active."),
        );
      } else {
        const reasons = {
          idle: "SchedulerNotStarted",
          starting: "SchedulerStarting",
          paused: "SchedulerPaused",
          stopped: "SchedulerStopped",
        } as const;
        conditions.push(
          condition(
            "SchedulerReady",
            "False",
            reasons[scheduler.phase],
            `Scheduler is ${scheduler.phase}.`,
          ),
        );
      }
    }

    return conditions;
  };
}
