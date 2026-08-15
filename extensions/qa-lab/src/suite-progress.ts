import type {
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
} from "./lab-server.types.js";

type QaSuiteProgressScenario = {
  id: string;
  title: string;
};

type QaSuiteProgressResult = {
  scenarioId: string;
  result: {
    name: string;
    status: "pass" | "fail" | "skip";
    steps: QaLabScenarioOutcome["steps"];
    details?: string;
  };
};

function cloneOutcome(outcome: QaLabScenarioOutcome): QaLabScenarioOutcome {
  return {
    ...outcome,
    ...(outcome.steps ? { steps: outcome.steps.map((step) => ({ ...step })) } : {}),
  };
}

export function createQaSuiteProgressController(params: {
  lab: QaLabServerHandle;
  scenarios: readonly QaSuiteProgressScenario[];
  startedAt: string;
}) {
  const outcomes = new Map<string, QaLabScenarioOutcome>(
    params.scenarios.map((scenario) => [
      scenario.id,
      {
        id: scenario.id,
        name: scenario.title,
        status: "pending" as const,
      },
    ]),
  );

  const emit = (status: QaLabScenarioRun["status"], finishedAt?: string) => {
    params.lab.setScenarioRun({
      kind: "suite",
      status,
      startedAt: params.startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      scenarios: params.scenarios.map((scenario) => cloneOutcome(outcomes.get(scenario.id)!)),
    });
  };

  const updateResult = (entry: QaSuiteProgressResult, finishedAt?: string) => {
    const current = outcomes.get(entry.scenarioId);
    if (!current) {
      return;
    }
    outcomes.set(entry.scenarioId, {
      ...current,
      name: entry.result.name,
      status: entry.result.status,
      ...(entry.result.details ? { details: entry.result.details } : {}),
      ...(entry.result.steps ? { steps: entry.result.steps } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    });
  };

  return {
    start() {
      emit("running");
    },
    markRunning(scenarioIds: readonly string[]) {
      const startedAt = new Date().toISOString();
      for (const scenarioId of scenarioIds) {
        const current = outcomes.get(scenarioId);
        if (!current || current.status !== "pending") {
          continue;
        }
        outcomes.set(scenarioId, { ...current, status: "running", startedAt });
      }
      emit("running");
    },
    recordResults(entries: readonly QaSuiteProgressResult[]) {
      const finishedAt = new Date().toISOString();
      for (const entry of entries) {
        updateResult(entry, finishedAt);
      }
      emit("running");
    },
    createPartitionLab(scenarioIds: readonly string[]): QaLabServerHandle {
      const partitionIds = new Set(scenarioIds);
      return {
        ...params.lab,
        setScenarioRun(next) {
          if (!next) {
            return;
          }
          for (const nextOutcome of next.scenarios) {
            if (!partitionIds.has(nextOutcome.id)) {
              continue;
            }
            const current = outcomes.get(nextOutcome.id);
            if (!current) {
              continue;
            }
            outcomes.set(nextOutcome.id, {
              ...current,
              ...nextOutcome,
            });
          }
          emit("running");
        },
        // Child partition reports are incomplete. The unified owner publishes one aggregate.
        setLatestReport() {},
      };
    },
    complete(entries: readonly QaSuiteProgressResult[], finishedAt: string) {
      for (const entry of entries) {
        updateResult(entry, finishedAt);
      }
      emit("completed", finishedAt);
    },
  };
}
