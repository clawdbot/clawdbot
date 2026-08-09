import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const effects = vi.hoisted(() => ({
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "agents/sticky-model-selection"
        ? { info: effects.info, warn: effects.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

// Sticky-model tests own persistence policy; session-utils.test.ts owns the thinking
// projection that otherwise materializes provider policy for every mutation here.
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionThinkingProjection: vi.fn(() => ({
      agentRuntime: { id: "openclaw", source: "implicit" },
      effectiveThinkingLevel: "off",
      thinkingLevels: [],
    })),
  };
});

import { sessionMutationHandlers } from "./sessions-mutations.js";

const cfg = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: [
      { id: "main", default: true },
      { id: "work", model: "anthropic/claude-sonnet-4-6" },
    ],
  },
} satisfies OpenClawConfig;

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: vi.fn(async () => [
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "openai", id: "gpt-5.6-sol" },
    ]),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

function client(scopes: string[]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
  };
}

async function patchSession(params: Record<string, unknown>, scopes = ["operator.admin"]) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: client(scopes),
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeEach(() => {
  effects.info.mockReset();
  effects.warn.mockReset();
  effects.mutateConfigFileWithRetry
    .mockReset()
    .mockImplementation(
      async (params: { mutate: (draft: OpenClawConfig, context: unknown) => unknown }) => {
        const draft = structuredClone(cfg);
        const result = await params.mutate(draft, {});
        return { nextConfig: draft, result };
      },
    );
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("sessions.patch sticky model persistence", () => {
  it.each([
    { agentId: "main", sessionKey: "agent:main:dm:sticky" },
    { agentId: "work", sessionKey: "agent:work:dm:sticky" },
  ])(
    "persists an accepted model for the resolved $agentId agent",
    async ({ agentId, sessionKey }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntry(
          { agentId, sessionKey },
          { sessionId: `session-${agentId}`, updatedAt: 1 },
        );

        const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

        expect(response[0]).toBe(true);
        await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
      });
    },
  );

  it("keeps a write-scoped model switch session-only without persisting the configured default", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dm:non-admin";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "session-non-admin", updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }, [
        "operator.write",
      ]);

      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    });
  });

  it("returns session success and warns when the sticky config write fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dm:write-failure";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId: "session-write-failure", updatedAt: 1 },
      );
      effects.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config write failed"));

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      await vi.waitFor(() =>
        expect(effects.warn).toHaveBeenCalledWith(
          "failed sticky model persistence agentId=main model=openai/gpt-5.6-sol reason=config write failed",
        ),
      );
    });
  });

  it.each([
    { name: "omitted", patch: { label: "Sticky" } },
    { name: "cleared", patch: { model: null } },
    { name: "reset to the current default", patch: { model: "anthropic/claude-opus-4-6" } },
  ])("does not persist when model is $name", async ({ patch }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dm:no-sticky";
      await upsertSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5.6-sol",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      );

      const response = await patchSession({ key: sessionKey, ...patch });

      expect(response[0]).toBe(true);
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    });
  });
});
