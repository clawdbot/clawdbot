import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
export type SessionRoutePresentation = Pick<GatewaySessionRow, "key" | "displayName" | "boardFace">;

export type SessionReferenceResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: SessionRoutePresentation }
  | { kind: "ambiguous"; sessions: SessionRoutePresentation[]; truncated: boolean };

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
): Promise<SessionReferenceResolution> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const result = await client.request<SessionsResolveResult>("sessions.resolve", {
    shortId: target.shortId,
    ...(target.slugHint ? { slugHint: target.slugHint } : {}),
    agentId: target.agentId,
    allowMissing: true,
  });
  signal.throwIfAborted();
  if (result.ok) {
    return { kind: "unique", session: result };
  }
  return result.candidates?.length
    ? { kind: "ambiguous", sessions: result.candidates, truncated: result.candidates.length === 10 }
    : { kind: "not-found" };
}
