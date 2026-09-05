import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
  CHAT_HISTORY_STARTUP_RETRY_TIMEOUT_MS,
  requestChatHistory,
} from "./chat-history-request.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import { prepareChatRouteStartup } from "./route-startup.ts";
export type SessionRoutePresentation = Pick<GatewaySessionRow, "key" | "displayName" | "boardFace">;

export type SessionReferenceResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: SessionRoutePresentation }
  | { kind: "ambiguous"; sessions: SessionRoutePresentation[]; truncated: boolean };

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
  startup = false,
): Promise<SessionReferenceResolution> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const selector = {
    shortId: target.shortId,
    ...(target.slugHint ? { slugHint: target.slugHint } : {}),
    agentId: target.agentId,
  };
  let result: SessionsResolveResult;
  if (startup) {
    const handoff = prepareChatRouteStartup(context, signal);
    const deadline = Date.now() + CHAT_HISTORY_STARTUP_RETRY_TIMEOUT_MS;
    const sourceCanonicalListRevision = context.sessions.canonicalListRevision;
    const { hello } = context.gateway.snapshot;
    const isCurrent = () =>
      !signal.aborted &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.hello === hello;
    try {
      const response = await requestChatHistory<
        ChatHistoryResult & { resolution: SessionsResolveResult }
      >(
        client,
        "chat.startup",
        {
          ...selector,
          limit: CHAT_HISTORY_REQUEST_LIMIT,
          maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES,
        },
        isCurrent,
        () => Date.now() < deadline,
      );
      signal.throwIfAborted();
      result = response.resolution;
      if (result.ok) {
        handoff.store(result.key, { ...response, sourceCanonicalListRevision });
      } else {
        handoff.dispose();
      }
    } catch (error) {
      handoff.dispose();
      throw error;
    }
  } else {
    result = await client.request<SessionsResolveResult>("sessions.resolve", {
      ...selector,
      allowMissing: true,
    });
  }
  signal.throwIfAborted();
  return sessionReferenceResolution(result);
}

export function sessionReferenceResolution(
  result: SessionsResolveResult,
): SessionReferenceResolution {
  if (result.ok) {
    return { kind: "unique", session: result };
  }
  return result.candidates?.length
    ? { kind: "ambiguous", sessions: result.candidates, truncated: result.candidates.length === 10 }
    : { kind: "not-found" };
}
