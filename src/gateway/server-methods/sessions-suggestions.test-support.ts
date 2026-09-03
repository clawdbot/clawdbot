import { afterEach, beforeEach, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionKey = "agent:main:main";

const defaultSuggestionSession = {
  sessionId: "session-main",
  updatedAt: 1,
  createdActor: { type: "human", source: "profile", id: "owner" },
  visibility: "suggest",
} as const;

export function upsertDefaultSuggestionSession() {
  return upsertSessionEntryCore({ agentId: "main", sessionKey }, defaultSuggestionSession);
}

export function client(profileId: string, displayName: string, admin = false): GatewayClient {
  return {
    connId: `conn-${profileId}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
        instanceId: `instance-${profileId}`,
      },
      role: "operator",
      scopes: admin ? ["operator.admin"] : ["operator.read", "operator.write"],
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: { profileId, displayName, hasAvatar: false, updatedAt: 1 },
  };
}

export function context(
  broadcast = vi.fn(),
  runtimeConfig: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => runtimeConfig,
    broadcast,
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

export async function call(
  method:
    | "session.suggestions.add"
    | "session.suggestions.list"
    | "session.suggestions.resolve"
    | "session.typing",
  params: Record<string, unknown>,
  requestClient: GatewayClient | null,
  requestContext = context(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSuggestionHandlers[method]?.({
    req: { type: "req", id: "request-1", method, params },
    params,
    client: requestClient,
    context: requestContext,
    isWebchatConnect: () => true,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return { responses, context: requestContext };
}

export function responseSuggestionId(result: Awaited<ReturnType<typeof call>>): string {
  const payload = result.responses[0]?.[1] as { suggestion?: { id?: string } } | undefined;
  if (!payload?.suggestion?.id) {
    throw new Error("suggestion response id missing");
  }
  return payload.suggestion.id;
}

export function registerSessionSuggestionTestLifecycle(mocks: {
  handleChatSend: ReturnType<typeof vi.fn>;
  suggestionMutationFailure?: string;
  presence: unknown[];
}): void {
  beforeEach(() => {
    mocks.handleChatSend.mockReset();
    mocks.handleChatSend.mockImplementation(({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "suggestion-run", status: "started" });
    });
    mocks.suggestionMutationFailure = undefined;
    mocks.presence = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });
}
