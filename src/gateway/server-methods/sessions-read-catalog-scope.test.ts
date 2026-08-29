import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const { sessionReadHandlers } = await import("./sessions-read.js");

function identifiedClient(profileId: string): GatewayClient {
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

function requestContext(config: OpenClawConfig): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => config,
    getSessionEventSubscriberConnIds: () => new Set(),
    loadGatewayModelCatalog: async () => [],
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function listSessions(params: {
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

async function seedSessions(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
  };
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:active" },
    {
      sessionId: "main-active",
      updatedAt: 400,
      createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      visibility: "shared",
    },
  );
  await upsertSessionEntryCore(
    { agentId: "work", sessionKey: "agent:work:active" },
    {
      sessionId: "work-active",
      updatedAt: 100,
      createdActor: { type: "human", source: "profile", id: "viewer@example.com" },
      visibility: "shared",
    },
  );
  return config;
}

beforeEach(() => {
  resetAgentEventsForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  vi.restoreAllMocks();
});

describe("sessions.list catalog scoping", () => {
  it("keeps unscoped listings owner-scoped when agents have distinct completed catalogs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const mainCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      const workCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["medium"] },
        },
      ];
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async (options?: { agentId?: string }) =>
          options?.agentId === "work" ? workCatalog : mainCatalog,
        ),
      };
      const client = identifiedClient("owner@example.com");
      const request = { archived: "all" as const, limit: 100 };

      const result = await listSessions({ client, context, request });

      const mainRow = result.sessions.find((session) => session.agentId === "main");
      const workRow = result.sessions.find((session) => session.agentId === "work");
      expect(mainRow).toBeDefined();
      expect(workRow).toBeDefined();
      expect(mainRow?.thinkingOptions).toEqual(
        expect.arrayContaining(["off", "low", "high", "max"]),
      );
      expect(workRow?.thinkingOptions).toEqual(expect.arrayContaining(["off", "medium"]));
      expect(workRow?.thinkingOptions).not.toEqual(expect.arrayContaining(["low", "high", "max"]));
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "main",
      });
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "work",
      });
    });
  });

  it("uses only the requested agent's catalog for scoped listings", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.agents = {
        ...config.agents,
        defaults: { model: { primary: "dynamic-router/reasoner" } },
      };
      const mainCatalog: ModelCatalogEntry[] = [
        {
          provider: "dynamic-router",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        },
      ];
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: vi.fn(async () => mainCatalog),
      };
      const client = identifiedClient("owner@example.com");

      const result = await listSessions({
        client,
        context,
        request: { agentId: "main", archived: "all" as const, limit: 100 },
      });

      expect(result.sessions.every((session) => session.agentId === "main")).toBe(true);
      expect(result.sessions[0]?.thinkingOptions).toEqual(
        expect.arrayContaining(["off", "low", "high", "max"]),
      );
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledTimes(1);
      expect(context.readPreparedGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "main",
      });
    });
  });
});
