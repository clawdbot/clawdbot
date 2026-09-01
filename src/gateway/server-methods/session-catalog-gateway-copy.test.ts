import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

const mocks = vi.hoisted(() => ({
  buildModelsListResult: vi.fn(async () => ({ models: [] as Array<Record<string, unknown>> })),
  createGatewaySession: vi.fn(async (params: Record<string, unknown>) => {
    const selected = typeof params.model === "string" ? params.model : "openai/team-default";
    const slash = selected.indexOf("/");
    const entry = {
      sessionId: "gateway-copy-session",
      updatedAt: 1,
      providerOverride: selected.slice(0, slash),
      modelOverride: selected.slice(slash + 1),
    };
    const afterCreate = params.afterCreate as
      | ((created: Record<string, unknown>) => Promise<void>)
      | undefined;
    await afterCreate?.({
      key: "agent:main:gateway-copy",
      agentId: "main",
      entry,
      storePath: "/tmp/test-sessions.json",
    });
    return {
      ok: true as const,
      key: "agent:main:gateway-copy",
      agentId: "main",
      entry,
      resolved: { modelProvider: entry.providerOverride, model: entry.modelOverride },
      resetExisting: false,
      postCommit: { status: "completed" as const },
    };
  }),
  importSessionCatalogHistory: vi.fn(async () => undefined),
  recordSessionStateEvent: vi.fn(),
}));

vi.mock("../../plugins/session-catalog-history-import.js", () => ({
  importSessionCatalogHistory: mocks.importSessionCatalogHistory,
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEvent: mocks.recordSessionStateEvent,
}));
vi.mock("../session-create-service.js", () => ({
  createGatewaySession: mocks.createGatewaySession,
}));
vi.mock("./models-list-result.js", () => ({
  buildModelsListResult: mocks.buildModelsListResult,
}));

const { copySessionCatalogToGateway } = await import("./session-catalog-gateway-copy.js");

function provider(): SessionCatalogProvider {
  return {
    id: "beam",
    label: "Beam",
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({
      hostId,
      threadId,
      items: [{ type: "userMessage" as const, text: "Continue here" }],
    })),
    copyToGatewaySession: vi.fn(async () => ({
      displayName: "Shared investigation",
      preferredModel: "openai/gpt-5.6-sol",
    })),
  };
}

describe("copySessionCatalogToGateway", () => {
  beforeEach(() => {
    mocks.buildModelsListResult.mockReset().mockResolvedValue({ models: [] });
    mocks.createGatewaySession.mockClear();
    mocks.importSessionCatalogHistory.mockClear();
    mocks.recordSessionStateEvent.mockClear();
  });

  it.each([
    {
      listed: true,
      available: true,
      restricted: false,
      expectedModel: "openai/gpt-5.6-sol",
      notice: "This session is using the source model, openai/gpt-5.6-sol.",
    },
    {
      listed: true,
      available: false,
      restricted: false,
      expectedModel: undefined,
      notice:
        "The source model, openai/gpt-5.6-sol, is not available to this Team agent, so this session is using its configured model, openai/team-default.",
    },
    {
      listed: false,
      available: true,
      restricted: false,
      expectedModel: undefined,
      notice:
        "The source model, openai/gpt-5.6-sol, is not available to this Team agent, so this session is using its configured model, openai/team-default.",
    },
    {
      listed: true,
      available: true,
      restricted: true,
      expectedModel: undefined,
      notice:
        "The source model, openai/gpt-5.6-sol, is not available to this Team agent, so this session is using its configured model, openai/team-default.",
    },
  ])(
    "copies history with source model listed = $listed, available = $available, and restricted = $restricted",
    async ({ listed, available, restricted, expectedModel, notice }) => {
      mocks.buildModelsListResult.mockResolvedValue({
        models: listed
          ? [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", available }]
          : [],
      });
      const catalog = provider();
      const result = await copySessionCatalogToGateway({
        request: { catalogId: "beam", hostId: "gateway", threadId: "beam-1" },
        provider: catalog,
        providerContinueParams: {
          hostId: "gateway",
          threadId: "beam-1",
          agentId: "main",
          allowProcessHomeFallback: false,
          clientScopes: ["operator.read", "operator.write"],
        },
        agentId: "main",
        clientScopes: ["operator.read", "operator.write"],
        client: {
          connect: { scopes: ["operator.read", "operator.write"] },
          authenticatedUserProfile: { profileId: "profile-owner" },
        } as never,
        context: {
          getRuntimeConfig: () => ({
            agents: {
              defaults: {
                model: { primary: "openai/team-default" },
                ...(restricted ? { models: { "openai/team-default": {} } } : {}),
              },
            },
          }),
          logGateway: { debug: vi.fn(), warn: vi.fn() },
          loadGatewayModelCatalog: vi.fn(async () => []),
        } as never,
      });

      expect(result).toEqual({ ok: true, sessionKey: "agent:main:gateway-copy" });
      expect(mocks.buildModelsListResult).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", params: { view: "all" } }),
      );
      expect(mocks.createGatewaySession).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          atomicInitialization: true,
          displayName: "Shared investigation",
          ...(expectedModel ? { model: expectedModel } : {}),
        }),
      );
      if (!expectedModel) {
        expect(mocks.createGatewaySession.mock.calls[0]?.[0]).not.toHaveProperty("model");
      }
      expect(mocks.importSessionCatalogHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogId: "beam",
          threadId: "beam-1",
          continuationNotice: expect.stringContaining(notice),
        }),
      );
      expect(mocks.recordSessionStateEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "adopted", sessionKey: "agent:main:gateway-copy" }),
      );
    },
  );
});
