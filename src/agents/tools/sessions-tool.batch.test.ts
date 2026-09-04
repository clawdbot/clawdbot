import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { flushPendingSessionsChangedEvents } from "../../gateway/server-methods/session-change-event.js";
import { sessionMutationHandlers } from "../../gateway/server-methods/sessions-mutations.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

const currentKey = "agent:main:main";
const targetKeys = ["agent:main:dashboard:first", "agent:main:dashboard:second"];

afterEach(() => flushPendingSessionsChangedEvents());

function createStoredSessionTool(config: OpenClawConfig = {}) {
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalog: async () => [],
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  const callGateway: AgentToolGatewayRequestCaller = async <T>(
    request: Parameters<AgentToolGatewayRequestCaller>[0],
  ) => {
    const handler = sessionMutationHandlers[request.method];
    if (!handler) {
      throw new Error(`Unexpected Gateway request: ${request.method}`);
    }
    const responses: Parameters<RespondFn>[] = [];
    await handler({
      req: { type: "req", id: "batch-tool-test", method: request.method, params: request.params },
      params: request.params as Record<string, unknown>,
      respond: (...response) => {
        responses.push(response);
      },
      context,
      client,
      isWebchatConnect: () => false,
    });
    const [ok, payload, error] = responses[0]!;
    if (!ok) {
      throw new GatewayClientRequestError(error!);
    }
    return payload as T;
  };
  return createSessionsTool({
    agentSessionKey: currentKey,
    agentSessionId: "current-session",
    config,
    callGateway,
  });
}

async function seedSessions() {
  for (const [index, sessionKey] of [currentKey, ...targetKeys].entries()) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: index === 0 ? "current-session" : `target-${index}`, updatedAt: 1 },
    );
  }
}

describe("sessions tool batch patch", () => {
  it("retains agent-selected model recovery for batch patches", async () => {
    const callGateway: AgentToolGatewayRequestCaller = async <T>() => {
      expect(isAgentSessionModelPatchOrigin()).toBe(true);
      return { outcomes: [{ ok: true, key: targetKeys[0] }] } as T;
    };
    const tool = createSessionsTool({ agentSessionKey: currentKey, config: {}, callGateway });
    const result = await tool.execute("batch-model", {
      action: "patch",
      targets: [{ sessionKey: targetKeys[0] }],
      model: "openai/gpt-5.6-luna",
    });
    expect(result.details).toMatchObject({ status: "updated", succeeded: [0], failed: [] });
    expect(isAgentSessionModelPatchOrigin()).toBe(false);
  });

  it("groups the selected sessions through the Gateway and reports a replaced target without touching the current session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSessions();
      const tool = createStoredSessionTool();
      const targets = targetKeys.map((sessionKey, index) => ({
        sessionKey,
        expectedSessionId: `target-${index + 1}`,
      }));
      expect(Value.Check(tool.parameters, { action: "patch", targets, group: "Reviews" })).toBe(
        true,
      );
      const grouped = await tool.execute("group-selected", {
        action: "patch",
        targets,
        group: "Reviews",
      });
      expect(grouped.details).toMatchObject({ status: "updated", succeeded: [0, 1], failed: [] });
      for (const sessionKey of targetKeys) {
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.category).toBe("Reviews");
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: targetKeys[1]! },
        { sessionId: "replacement", updatedAt: 2, category: "Replacement" },
      );
      const changed = await tool.execute("regroup-selected", {
        action: "patch",
        targets,
        group: "Done",
      });
      expect(changed.details).toMatchObject({
        status: "partial",
        succeeded: [0],
        failed: [1],
        errors: [{ index: 1, message: expect.stringContaining("changed") }],
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: targetKeys[0]! })?.category).toBe(
        "Done",
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: targetKeys[1]! })?.category).toBe(
        "Replacement",
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: currentKey })?.category,
      ).toBeUndefined();
    });
  });

  it("continues valid archives after missing identity and current-session targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSessions();
      const tool = createStoredSessionTool();
      const result = await tool.execute("archive-selected", {
        action: "patch",
        targets: [
          { sessionKey: targetKeys[0] },
          { sessionKey: currentKey, expectedSessionId: "current-session" },
          { sessionKey: targetKeys[1], expectedSessionId: "target-2" },
        ],
        archived: true,
      });
      expect(result.details).toMatchObject({ status: "partial", succeeded: [2], failed: [0, 1] });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: currentKey })?.archivedAt,
      ).toBeUndefined();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: targetKeys[0]! })?.archivedAt,
      ).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", sessionKey: targetKeys[1]! })?.archivedAt).toEqual(
        expect.any(Number),
      );
    });
  });

  it("preserves session visibility while applying allowed targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSessions();
      const tool = createStoredSessionTool({ tools: { sessions: { visibility: "self" } } });
      const result = await tool.execute("pin-visible", {
        action: "patch",
        targets: [{ sessionKey: targetKeys[0] }, { sessionKey: "current" }],
        pinned: true,
      });
      expect(result.details).toMatchObject({ status: "partial", succeeded: [1], failed: [0] });
      expect(loadSessionEntry({ agentId: "main", sessionKey: currentKey })?.pinnedAt).toEqual(
        expect.any(Number),
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: targetKeys[0]! })?.pinnedAt,
      ).toBeUndefined();
    });
  });

  it("rejects duplicate aliases before any batch mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedSessions();
      const tool = createStoredSessionTool();
      await expect(
        tool.execute("duplicate-target", {
          action: "patch",
          targets: [{ sessionKey: "current" }, { sessionKey: currentKey }],
          pinned: true,
        }),
      ).rejects.toThrow("Duplicate target");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: currentKey })?.pinnedAt,
      ).toBeUndefined();
    });
  });

  it.each([
    { name: "empty batch", args: { targets: [] } },
    {
      name: "overlong batch",
      args: { targets: Array.from({ length: 101 }, () => ({ sessionKey: currentKey })) },
    },
    {
      name: "mixed session selectors",
      args: { targets: [{ sessionKey: currentKey }], sessionKey: currentKey },
    },
    {
      name: "shared lifecycle identity",
      args: { targets: [{ sessionKey: currentKey }], expectedSessionId: "current-session" },
    },
    { name: "different action", args: { action: "reset", targets: [{ sessionKey: currentKey }] } },
  ])("rejects $name before dispatch", async ({ args }) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({ agentSessionKey: currentKey, config: {}, callGateway });
    await expect(
      tool.execute("invalid-batch", { action: "patch", pinned: true, ...args }),
    ).rejects.toThrow();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("accounts for all 100 failures within the response budget", async () => {
    const callGateway = vi.fn(async () => ({
      outcomes: Array.from({ length: 100 }, (_, index) => ({
        ok: false,
        key: `agent:main:dashboard:${index}`,
        error: { code: "INVALID_REQUEST", message: "界".repeat(10_000) },
      })),
    }));
    const tool = createSessionsTool({
      agentSessionKey: currentKey,
      config: {},
      callGateway: callGateway as AgentToolGatewayRequestCaller,
    });
    const result = await tool.execute("failed-batch", {
      action: "patch",
      pinned: true,
      targets: Array.from({ length: 100 }, (_, index) => ({
        sessionKey: `agent:main:dashboard:${index}`,
      })),
    });
    expect(result.details).toMatchObject({
      status: "error",
      succeeded: [],
      failed: Array.from({ length: 100 }, (_, index) => index),
      warning: expect.stringContaining("omitted"),
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(3_840);
  });
});
