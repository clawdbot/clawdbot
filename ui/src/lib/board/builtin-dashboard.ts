import type { SessionObserverDigest } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { withObserverWidget } from "./observer-dashboard.ts";
import type { BoardSnapshot } from "./types.ts";
import type { BoardViewSnapshot } from "./view-types.ts";

export function withBuiltinDashboardWidgets(
  snapshot: BoardSnapshot,
  observerDigests: readonly SessionObserverDigest[],
): BoardViewSnapshot {
  return withObserverWidget(snapshot, observerDigests);
}
