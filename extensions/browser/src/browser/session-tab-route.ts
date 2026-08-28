import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { BrowserTabOwnership } from "./client.types.js";

export type BrowserSessionTabRoute =
  | { kind: "browser-control"; baseUrl?: string }
  | {
      kind: "node-proxy";
      nodeId: string;
      closeTarget: (tab: {
        targetId: string;
        profile?: string;
        ownership?: BrowserTabOwnership;
      }) => Promise<CloseTrackedCdpTargetResult>;
    };

export function browserSessionTabRouteKey(route: BrowserSessionTabRoute): string {
  return route.kind === "node-proxy" ? `node:${route.nodeId}` : `control:${route.baseUrl ?? ""}`;
}

export function parseBrowserSessionTabCloseResult(value: unknown): CloseTrackedCdpTargetResult {
  const status = asNullableRecord(value)?.status;
  if (
    status === "cancelled" ||
    status === "closed" ||
    status === "missing" ||
    status === "ownership-mismatch"
  ) {
    return { status };
  }
  if (status === "unavailable") {
    return { status, reason: "target-close-failed" };
  }
  return { status: "unavailable", reason: "target-close-failed" };
}
