import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Carry exact local-turn cleanup until the embedded handle captures it; never recover by session id.
const forcedTerminalSettlement = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementForcedTerminalSettlement"),
  () => new AsyncLocalStorage<() => Promise<void>>(),
);

export function withSessionPlacementForcedTerminalSettlement<T>(
  settle: () => Promise<void>,
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.run(settle, task);
}

export function resolveSessionPlacementForcedTerminalSettlement():
  | (() => Promise<void>)
  | undefined {
  return forcedTerminalSettlement.getStore();
}
