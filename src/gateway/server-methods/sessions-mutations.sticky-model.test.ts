import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const effects = vi.hoisted(() => ({
  persistStickyModelSelection: vi.fn(async () => "defaults" as const),
}));

vi.mock("../../agents/sticky-model-selection.js", () => ({
  persistStickyModelSelection: effects.persistStickyModelSelection,
}));

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

async function patchSession(params: Record<string, unknown>) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: null,
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeEach(() => {
  effects.persistStickyModelSelection.mockClear();
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
        expect(effects.persistStickyModelSelection).toHaveBeenCalledWith({
          agentId,
          model: "openai/gpt-5.6-sol",
        });
      });
    },
  );

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
      expect(effects.persistStickyModelSelection).not.toHaveBeenCalled();
    });
  });
});
