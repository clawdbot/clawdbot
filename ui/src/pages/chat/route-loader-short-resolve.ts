import { ErrorCodes } from "@openclaw/gateway-client/browser";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import {
  resolveShortSessionReferenceWithListFallback,
  type ShortSessionListFallbackResolution,
} from "./route-loader-short-list-fallback.ts";

export type SessionReferenceResolution = ShortSessionListFallbackResolution;

type SessionsResolveWireResult =
  | { ok: true; key: string }
  | { ok: false; candidates?: Array<{ key: string; displayName?: string }> };

function isPriorGatewayShortIdRejection(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === ErrorCodes.INVALID_REQUEST &&
    error.message.includes("invalid sessions.resolve params:") &&
    error.message.includes("unexpected property 'shortId'")
  );
}

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
): Promise<SessionReferenceResolution> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  let result: SessionsResolveWireResult;
  try {
    result = await client.request<SessionsResolveWireResult>("sessions.resolve", {
      shortId: target.shortId,
      ...(target.slugHint ? { slugHint: target.slugHint } : {}),
      agentId: target.agentId,
      allowMissing: true,
    });
  } catch (error) {
    if (!isPriorGatewayShortIdRejection(error)) {
      throw error;
    }
    return resolveShortSessionReferenceWithListFallback(context, target, signal);
  }
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
