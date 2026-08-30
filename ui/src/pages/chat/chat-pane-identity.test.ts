/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat pane assistant identity snapshots", () => {
  it("rebinds agent-owned presentation when a retained fixed route changes owner", () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const sessions = createSessionCapabilityFixture({ retireModelOverride });
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:main:main";
    state.assistantAgentId = "main";
    state.assistantName = "Main Agent";
    state.chatAvatarUrl = "https://example.test/main-avatar.png";
    state.modelAuthStatusResult = { ts: 1, providers: [] };
    state.chatModelSwitchPromises = {
      "agent:main:main": new Promise<boolean>(() => {}),
    };
    state.loadAssistantIdentity = vi.fn(async () => undefined);
    pane.sessionKey = "agent:work:main";

    (
      pane as TestChatPane & {
        willUpdate: (changedProperties: Map<PropertyKey, unknown>) => void;
      }
    ).willUpdate(new Map([["sessionKey", "agent:main:main"]]));

    expect(state.sessionKey).toBe("agent:work:main");
    expect(state.assistantAgentId).toBe("work");
    expect(state.assistantName).toBe("");
    expect(state.chatAvatarUrl).toBeNull();
    expect(state.modelAuthStatusResult).toBeNull();
    expect(state.loadAssistantIdentity).toHaveBeenCalledOnce();
    expect(retireModelOverride).toHaveBeenCalledWith("agent:work:main");
  });

  it("rebinds approval delivery when the selected global agent changes", async () => {
    const replacement = createDeferred<{
      key: string;
      agentId: string;
      includeApprovals: true;
      approvalReplay: { sessionKey: string; updatedAtMs: number; approvals: []; truncated: false };
    }>();
    const subscribeMessages = vi.fn(
      async (key: string, options?: { agentId?: string | null; includeApprovals?: boolean }) => {
        const agentId = options?.agentId ?? null;
        if (agentId === "research") {
          return replacement.promise;
        }
        return {
          key,
          agentId,
          includeApprovals: true as const,
          approvalReplay: {
            sessionKey: "agent:main:global",
            updatedAtMs: 1,
            approvals: [],
            truncated: false as const,
          },
        };
      },
    );
    const unsubscribeMessages = vi.fn(async () => undefined);
    const sessions = createSessionCapabilityFixture({
      state: {
        result: null,
        agentId: null,
        modelOverrides: {},
        loading: false,
        error: null,
        deletedSessions: [],
        groups: [],
        groupSettings: [],
        sectionOrder: [],
      },
      subscribe: () => () => undefined,
      subscribeMessages,
      unsubscribeMessages,
    });
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const context = createSessionContext(client, sessions);
    Object.assign(context.agents, { ensureList: vi.fn(async () => null) });
    Object.assign(context.config.current, {
      allowExternalEmbedUrls: false,
      embedSandboxMode: "strict",
      localMediaPreviewRoots: [],
      serverVersion: null,
    });
    Object.assign(context.config, { subscribe: () => () => undefined });
    Object.assign(context, {
      placementStartup: {
        get: () => null,
        hasPendingTurn: () => false,
        retry: () => undefined,
        subscribe: () => () => undefined,
      },
      runtimeConfig: {
        state: { configNeedsApply: false, configSnapshot: null },
        subscribe: () => () => undefined,
      },
    });
    const { pane } = createTestChatPane({ client, sessions });
    pane.context = context;
    pane.connectedClient = null;
    pane.sessionKey = "global";
    (pane as TestChatPane & { render: () => null }).render = () => null;

    try {
      pane.connectedCallback();
      await vi.waitFor(() =>
        expect(subscribeMessages).toHaveBeenCalledWith("global", {
          agentId: "main",
          includeApprovals: true,
        }),
      );
      pane.state.chatSessionApprovalQueue = [
        {
          id: "stale-main-approval",
          kind: "exec",
          request: { command: "echo stale", agentId: "main", sessionKey: "global" },
          createdAtMs: 1,
          expiresAtMs: 10_000,
        },
      ];

      pane.state.loadAssistantIdentity = vi.fn(async () => undefined);
      context.agentSelection.set("research");

      expect(pane.state.chatSessionApprovalQueue).toEqual([]);
      await vi.waitFor(() =>
        expect(subscribeMessages).toHaveBeenCalledWith("global", {
          agentId: "research",
          includeApprovals: true,
        }),
      );
      expect(unsubscribeMessages).toHaveBeenCalledWith(
        expect.objectContaining({ key: "global", agentId: "main" }),
      );
      replacement.resolve({
        key: "global",
        agentId: "research",
        includeApprovals: true,
        approvalReplay: {
          sessionKey: "agent:research:global",
          updatedAtMs: 2,
          approvals: [],
          truncated: false,
        },
      });
      await vi.waitFor(() =>
        expect(pane.state.chatSessionMessageSubscription).toEqual(
          expect.objectContaining({ key: "global", agentId: "research" }),
        ),
      );
    } finally {
      pane.disconnectedCallback();
    }
  });

  it("keeps a session-specific assistant identity across ordinary gateway snapshots", () => {
    const client = {} as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const state = (pane as unknown as { state: ChatPageHost }).state;
    state.client = client;
    state.connected = true;
    state.assistantName = "Session Agent";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
    });

    expect(state.assistantName).toBe("Session Agent");
  });

  it("resets a session-specific identity when the logical connection changes", () => {
    const client = {} as GatewayBrowserClient;
    const nextClient = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.assistantName = "Session Agent";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: nextClient,
      phase: "reconnecting" as const,
    });

    expect(state.assistantName).toBe(pane.context.config.current.assistantIdentity.name);
  });
});
