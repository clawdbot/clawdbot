import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Carry exact local-turn cleanup to its reply and backend owners; never recover by session id.
const forcedTerminalSettlement = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementForcedTerminalSettlement"),
  () => new AsyncLocalStorage<{ settle: () => Promise<void>; assertCurrent: () => void }>(),
);

export function withSessionPlacementForcedTerminalSettlement<T>(
  settle: () => Promise<void>,
  assertClaimCurrent: () => void,
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.run({ settle, assertCurrent: assertClaimCurrent }, task);
}

export function resolveSessionPlacementForcedTerminalSettlement():
  | (() => Promise<void>)
  | undefined {
  return forcedTerminalSettlement.getStore()?.settle;
}

export function resolveSessionPlacementTurnSettlementAssertion(): (() => void) | undefined {
  return forcedTerminalSettlement.getStore()?.assertCurrent;
}

/** A new admission must acquire its own claim, never inherit its invoker's. */
export function withoutSessionPlacementForcedTerminalSettlement<T>(
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.exit(task);
}
