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
  bind(run: OperationalRunInstanceRef): ComputerToolTransport | null;
}>;

const placementComputer = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementComputer"),
  () => new AsyncLocalStorage<PlacementComputerContext>(),
);

/** Absence means ordinary node routing; null explicitly withholds an unavailable placed desktop. */
export function resolveSessionPlacementComputer(run: OperationalRunInstanceRef | undefined) {
  const context = placementComputer.getStore();
  return context
    ? run && run.runId === context.runId && context.isActive()
      ? context.bind(run)
      : null
    : undefined;
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
