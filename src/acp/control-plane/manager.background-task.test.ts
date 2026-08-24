/** Regression coverage for ACP background-task summary truncation boundaries. */
import { afterEach, describe, expect, it } from "vitest";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { bindTaskRunExecution } from "../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskRegistryForTests,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import {
  appendBackgroundTaskProgressSummary,
  bindBackgroundTaskExecution,
  createBackgroundTaskRecord,
  resolveBackgroundTaskContext,
  resolveBackgroundTaskFailureStatus,
} from "./manager.background-task.js";
import { ACP_TURN_TIMEOUT_DETAIL_CODE } from "./manager.turn-timeout.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";

// U+1F99E (🦞) is a surrogate pair in UTF-16; a raw .slice() boundary can split it.
const LOBSTER = "🦞";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

const HIGH_SURROGATE_WITHOUT_LOW = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

function fakeDeps(): AcpSessionManagerDeps {
  const loadSessionEntry = (params: { sessionKey: string }) =>
    params.sessionKey === "child-session"
      ? { entry: { spawnedBy: "requester-session" } }
      : { entry: {} };
  return { loadSessionEntry } as unknown as AcpSessionManagerDeps;
}

describe("appendBackgroundTaskProgressSummary", () => {
  it("keeps surrogate pairs intact at the progress truncation boundary", () => {
    // combined length 244 puts the pair astride the 239-char cut point.
    const result = appendBackgroundTaskProgressSummary("x".repeat(238), `${LOBSTER}tail`);
    expect(result).toBe(`${"x".repeat(238)}…`);
    expect(HIGH_SURROGATE_WITHOUT_LOW.test(result)).toBe(false);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it("still truncates plain ASCII exactly at the boundary", () => {
    const result = appendBackgroundTaskProgressSummary("a".repeat(240), "b");
    expect(result).toBe(`${"a".repeat(239)}…`);
  });

  it("returns short combined summaries unchanged", () => {
    expect(appendBackgroundTaskProgressSummary("done: ", "ok")).toBe("done: ok");
    expect(appendBackgroundTaskProgressSummary("", `  step ${LOBSTER}`)).toBe(`step ${LOBSTER}`);
  });
});

describe("resolveBackgroundTaskContext", () => {
  it("keeps surrogate pairs intact in the bounded task label", () => {
    // normalized length 164 puts the pair astride the 159-char cut point.
    const context = resolveBackgroundTaskContext({
      deps: fakeDeps(),
      cfg: {} as unknown as OpenClawConfig,
      sessionKey: "child-session",
      requestId: "run-1",
      text: `${"y".repeat(158)}${LOBSTER}tail`,
    });
    expect(context?.task).toBe(`${"y".repeat(158)}…`);
    expect(HIGH_SURROGATE_WITHOUT_LOW.test(context?.task ?? "")).toBe(false);
  });

  it("passes short task text through unchanged", () => {
    const context = resolveBackgroundTaskContext({
      deps: fakeDeps(),
      cfg: {} as unknown as OpenClawConfig,
      sessionKey: "child-session",
      requestId: "run-2",
      text: `summarize ${LOBSTER} feedback`,
    });
    expect(context?.task).toBe(`summarize ${LOBSTER} feedback`);
  });
});

describe("resolveBackgroundTaskFailureStatus", () => {
  it("uses the structured timeout detail instead of message text", () => {
    expect(
      resolveBackgroundTaskFailureStatus(
        new AcpRuntimeError("ACP_TURN_FAILED", "turn deadline reached", {
          detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE,
        }),
      ),
    ).toBe("timed_out");
    expect(
      resolveBackgroundTaskFailureStatus(
        new AcpRuntimeError("ACP_TURN_FAILED", "backend said the request timed out"),
      ),
    ).toBe("failed");
  });
});

describe("ACP background task execution binding", () => {
  it("binds the exact admitted execution only at prompt submission", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-execution-binding-" },
      async () => {
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
        const admitted: AdmittedRunContext = {
          operationalRunInstance: { instanceId: "instance-acp", runId: "run-acp" },
          executionIdentityToken: createExecutionIdentityAdmissionToken("run-acp", {
            contextId: "context-acp",
            executionId: "execution-acp",
          }),
        };
        const record = createBackgroundTaskRecord(
          {
            requesterSessionKey: "agent:main:main",
            childSessionKey: "agent:qa:child",
            runId: "run-acp",
            task: "private",
          },
          100,
        );
        const task = findTaskByRunId("run-acp");
        if (!record || !task?.parentFlowId) {
          throw new Error("expected ACP task and owner flow");
        }
        const db = openOpenClawStateDatabase().db;
        expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);

        bindBackgroundTaskExecution(record, admitted);

        expect(
          db
            .prepare(
              `SELECT owner_kind, owner_id, context_id, execution_id
               FROM execution_owner_lifecycle_bindings
               ORDER BY owner_kind`,
            )
            .all(),
        ).toEqual([
          {
            owner_kind: "flow",
            owner_id: task.parentFlowId,
            context_id: "context-acp",
            execution_id: "execution-acp",
          },
          {
            owner_kind: "task",
            owner_id: task.taskId,
            context_id: "context-acp",
            execution_id: "execution-acp",
          },
        ]);
      },
    );
  });

  it.each(["missing", "mismatched"] as const)(
    "does not bind a live parent flow when the task owner is %s",
    async (taskOwnerState) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `openclaw-acp-${taskOwnerState}-task-binding-` },
        async () => {
          resetTaskRegistryForTests();
          resetTaskFlowRegistryForTests();
          const admitted: AdmittedRunContext = {
            operationalRunInstance: { instanceId: "instance-acp", runId: "run-acp" },
            executionIdentityToken: createExecutionIdentityAdmissionToken("run-acp", {
              contextId: "context-acp",
              executionId: "execution-acp",
            }),
          };
          const record = createBackgroundTaskRecord(
            {
              requesterSessionKey: "agent:main:main",
              childSessionKey: "agent:qa:child",
              runId: "run-acp",
              task: "private",
            },
            100,
          );
          const task = findTaskByRunId("run-acp");
          if (!record || !task?.parentFlowId) {
            throw new Error("expected ACP task and owner flow");
          }
          const db = openOpenClawStateDatabase().db;
          if (taskOwnerState === "missing") {
            db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(task.taskId);
          } else {
            expect(
              bindTaskRunExecution({
                taskId: task.taskId,
                admitted: {
                  operationalRunInstance: { instanceId: "instance-other", runId: "run-other" },
                  executionIdentityToken: createExecutionIdentityAdmissionToken("run-other", {
                    contextId: "context-other",
                    executionId: "execution-other",
                  }),
                },
              }),
            ).toBe("bound");
          }

          bindBackgroundTaskExecution(record, admitted);

          if (taskOwnerState === "missing") {
            expect(tableExists(db, "execution_owner_lifecycle_bindings")).toBe(false);
          } else {
            expect(
              db
                .prepare(
                  `SELECT context_id, execution_id
                   FROM execution_owner_lifecycle_bindings
                   WHERE owner_kind = 'flow' AND owner_id = ?`,
                )
                .get(task.parentFlowId),
            ).toBeUndefined();
          }
        },
      );
    },
  );
});
