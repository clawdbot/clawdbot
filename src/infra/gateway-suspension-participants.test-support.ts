// Clears the suspension participant registry between tests.
//
// The registry keeps its state in a global singleton, so this resolves the same
// slot instead of making the production module export a test-only reset seam.
// Importing the registry first guarantees the slot exists and is fully shaped.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import "./gateway-suspension-participants.js";

type ClearableParticipantState = {
  participants: { clear: () => void };
  prepared: { clear: () => void };
};

export function resetGatewaySuspensionParticipantsForTest(): void {
  const state = resolveGlobalSingleton(
    Symbol.for("openclaw.gatewaySuspensionParticipantState"),
    (): ClearableParticipantState => ({ participants: new Map(), prepared: new Set() }),
  );
  state.participants.clear();
  state.prepared.clear();
}
