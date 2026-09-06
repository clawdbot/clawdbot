import { expect, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export { sessionReadHandlers };

export function identifiedClient(profileId: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

export function requestContext(config: OpenClawConfig): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: async () => [],
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

export async function listSessions(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  request: SessionsListParams;
}) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionReadHandlers["sessions.list"]?.({
    params: params.request,
    client: params.client,
    context: params.context,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
  return responses[0]?.[1] as {
    count: number;
    nextOffset: number | null;
    sessions: GatewaySessionRow[];
    totalCount: number;
  };
}

export async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  for (const [agentId, name, updatedAt, owner, overrides] of [
    ["main", "active", 400, "owner@example.com", {}],
    ["main", "draft", 300, "owner@example.com", { visibility: "draft" }],
    ["main", "archived", 200, "viewer@example.com", { archivedAt: 200 }],
    ["work", "active", 100, "viewer@example.com", {}],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:${name}` },
      {
        sessionId: `${agentId}-${name}`,
        updatedAt,
        createdActor: { type: "human", source: "profile", id: owner },
        visibility: "shared",
        ...overrides,
      },
    );
  }
  return config;
}

export async function seedSessionsWithActivityTimes() {
  const clock = vi.spyOn(Date, "now").mockReturnValue(400);
  const config = await seedSessions();
  for (const [name, updatedAt] of [
    ["active", 400],
    ["draft", 300],
    ["archived", 200],
  ] as const) {
    const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error(`Missing seeded session ${scope.sessionKey}`);
    }
    await replaceSessionEntry(scope, { ...entry, updatedAt });
    expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
  }
  return { clock, config };
}
