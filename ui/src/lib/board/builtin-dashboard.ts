import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { withObserverWidget } from "./observer-dashboard.ts";
import { withSwarmWidget } from "./swarm-dashboard.ts";
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

export function withBuiltinDashboardWidgets(
  snapshot: BoardSnapshot,
  sessions: readonly GatewaySessionRow[],
  observerDigests: readonly SessionObserverDigest[],
): BoardViewSnapshot {
  return withObserverWidget(withSwarmWidget(snapshot, sessions), observerDigests);
}
