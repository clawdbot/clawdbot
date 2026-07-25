import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { withObserverWidget } from "./observer-dashboard.ts";
import { isSwarmEnabledInConfig, SwarmRosterHydrator, withSwarmWidget } from "./swarm-dashboard.ts";

export { isSwarmEnabledInConfig, SwarmRosterHydrator };
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

export function withBuiltinDashboardWidgets(
  snapshot: BoardSnapshot,
  sessions: readonly GatewaySessionRow[],
  observerDigests: readonly SessionObserverDigest[],
  swarmEnabled = true,
): BoardViewSnapshot {
  const withSwarm = swarmEnabled ? withSwarmWidget(snapshot, sessions) : snapshot;
  return withObserverWidget(withSwarm, observerDigests);
}
