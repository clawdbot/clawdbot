import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";

export type SessionReferenceResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

type SessionsResolveWireResult =
  | { ok: true; key: string }
  | { ok: false; candidates?: Array<{ key: string; displayName?: string }> };

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
): Promise<SessionReferenceResolution> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const result = await client.request<SessionsResolveWireResult>("sessions.resolve", {
    shortId: target.shortId,
    ...(target.slugHint ? { slugHint: target.slugHint } : {}),
    agentId: target.agentId,
    allowMissing: true,
  });
  signal.throwIfAborted();
  const candidates = result.ok ? [{ key: result.key }] : result.candidates;
  if (!candidates?.length) {
    return { kind: "not-found" };
  }
  const rows = (
    await Promise.all(
      candidates.map(async ({ key }) => {
        const described = await client.request<{ session?: GatewaySessionRow | null }>(
          "sessions.describe",
          { key },
        );
        return described.session ?? null;
      }),
    )
  ).filter((row): row is GatewaySessionRow => row !== null);
  signal.throwIfAborted();
  if (result.ok) {
    return rows[0] ? { kind: "unique", session: rows[0] } : { kind: "not-found" };
  }
  return { kind: "ambiguous", sessions: rows, truncated: candidates.length === 10 };
}
