import type { AgentToolResult } from "./runtime/index.js";
import type { InternalToolExecutionPreparer } from "./runtime/internal-hooks.js";

const INTERNAL_EXECUTION_CONTROL = Symbol("openclawInternalExecutionControl");

type InternalExecutionControl = {
  [INTERNAL_EXECUTION_CONTROL]: true;
  ready: Promise<unknown>;
  pause: (args: unknown) => Promise<{ launch: boolean; start?: () => void }>;
  launch: (start?: () => void) => void;
  dispose: () => void;
};

function createControl(): InternalExecutionControl {
  let markReady!: (args: unknown) => void;
  let decide!: (value: { launch: boolean; start?: () => void }) => void;
  const ready = new Promise<unknown>((resolve) => {
    markReady = resolve;
  });
  const decision = new Promise<{ launch: boolean; start?: () => void }>((resolve) => {
    decide = resolve;
  });
  return {
    [INTERNAL_EXECUTION_CONTROL]: true,
    ready,
    pause: (args) => {
      markReady(args);
      return decision;
    },
    launch: (start) => decide({ launch: true, start }),
    dispose: () => decide({ launch: false }),
  };
}

export function readInternalExecutionControl(value: unknown): InternalExecutionControl | undefined {
  return value &&
    typeof value === "object" &&
    (value as Partial<InternalExecutionControl>)[INTERNAL_EXECUTION_CONTROL] === true
    ? (value as InternalExecutionControl)
    : undefined;
}

export function createInternalExecutionPreparer(
  startExecution: (
    params: Parameters<InternalToolExecutionPreparer>[0],
    control: InternalExecutionControl,
  ) => Promise<AgentToolResult<unknown>>,
): InternalToolExecutionPreparer {
  return async (params) => {
    const control = createControl();
    const execution = startExecution(params, control);
    const settled = await Promise.race([
      control.ready.then((args) => ({ kind: "ready" as const, args })),
      execution.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    ]);
    if (settled.kind !== "ready") {
      return {
        kind: "immediate",
        outcome:
          settled.kind === "result"
            ? { kind: "result", result: settled.result, isError: false }
            : { kind: "error", error: settled.error },
        dispose() {},
      };
    }
    let disposed = false;
    return {
      kind: "ready",
      args: settled.args,
      execute(start) {
        if (!disposed) {
          control.launch(start);
        }
        return execution;
      },
      dispose() {
        if (!disposed) {
          disposed = true;
          control.dispose();
          void execution.catch(() => undefined);
        }
      },
    };
  };
}
