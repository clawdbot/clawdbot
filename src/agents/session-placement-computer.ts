import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OperationalRunInstanceRef } from "./admitted-run-context.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import type { ComputerToolTransport } from "./tools/computer-tool.js";

type PlacementComputerContext = Readonly<{
  runId: string;
  agentId: string;
  isActive(): boolean;
  sandboxToolPolicy?: SandboxToolPolicy;
  computerUse: NonNullable<ComputerToolTransport["computerUse"]> | null;
  bind(run: OperationalRunInstanceRef): ComputerToolTransport | null;
}>;

const placementComputer = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementComputer"),
  () => new AsyncLocalStorage<PlacementComputerContext>(),
);

export type CapturedSessionPlacementComputer = Readonly<{
  computerUse: NonNullable<ComputerToolTransport["computerUse"]>;
  bind(run: OperationalRunInstanceRef): ComputerToolTransport | null;
}>;

/** Capture the prepared owner without binding authority or consulting another request's ALS later. */
export function captureSessionPlacementComputer(scope: {
  runId?: string;
  agentId?: string;
}): CapturedSessionPlacementComputer | null | undefined {
  const context = placementComputer.getStore();
  if (!context) {
    return undefined;
  }
  const isCurrent = () =>
    scope.runId === context.runId &&
    (scope.agentId === undefined || scope.agentId === context.agentId) &&
    context.isActive();
  if (!isCurrent() || context.computerUse === null) {
    return null;
  }
  return Object.freeze({
    computerUse: context.computerUse,
    bind: (run: OperationalRunInstanceRef) =>
      isCurrent() && run.runId === context.runId ? context.bind(run) : null,
  });
}

/** Absence means ordinary routing; null withholds an unavailable or stale placed desktop. */
export function resolveSessionPlacementComputer(run: OperationalRunInstanceRef | undefined) {
  const owner = captureSessionPlacementComputer({ runId: run?.runId });
  return owner && run ? owner.bind(run) : owner === undefined ? undefined : null;
}

/** Select policy facts without opening a transport or activating a dormant sandbox. */
export function resolveSessionPlacementSandboxToolPolicy(
  policy: SandboxToolPolicy | undefined,
  scope: { runId?: string; agentId?: string },
): SandboxToolPolicy | undefined {
  const context = placementComputer.getStore();
  return policy &&
    context &&
    scope.runId === context.runId &&
    scope.agentId === context.agentId &&
    context.isActive()
    ? (context.sandboxToolPolicy ?? policy)
    : policy;
}

export function withSessionPlacementComputer<T>(
  context: PlacementComputerContext,
  run: () => Promise<T>,
): Promise<T> {
  return placementComputer.run(context, run);
}
