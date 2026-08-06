/** Test-only access to the process-global ACP active-turn registry. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type AcpActiveTurnState = {
  activeTurnKeys: Set<string>;
};

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

export function resetAcpActiveTurnsForTests(): void {
  resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Set<string>(),
  })).activeTurnKeys.clear();
}
