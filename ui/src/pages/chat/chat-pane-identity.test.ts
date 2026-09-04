/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createInitializationContext,
  createRenderTestChatPane,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";
import { renderChat } from "./chat-view.ts";
import { projectSessionApprovalReplay } from "./session-approval-projection.ts";

describe("chat pane assistant identity snapshots", () => {
  it("keeps an explicitly owned global Home pane on its agent across work selection", () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    (pane as TestChatPane & { agentId: string }).agentId = "personal";
    pane.sessionKey = "global";
    state.sessionKey = "global";
    state.assistantAgentId = "personal";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    pane.context.agentSelection.set("work");

    pane.applyGatewaySnapshot(pane.context.gateway.snapshot);

    expect(state.assistantAgentId).toBe("personal");
    expect(pane.context.agentSelection.state.selectedId).toBe("work");
  });

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
      refresh: vi.fn().mockResolvedValue(undefined),
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

describe("chat pane approval requester identity", () => {
  it("renders projected approval requester titles from reactive session metadata without changing decision routing", async () => {
    const pane = createRenderTestChatPane();
    const host = {
      key: "agent:main:dashboard:approval-host",
      kind: "direct",
      updatedAt: 1,
      label: "Presentation session label",
      displayName: "Presentation session display name",
      derivedTitle: "Presentation session derived title",
    } satisfies GatewaySessionRow;
    const source = {
      key: "agent:main:dashboard:11111111-2222-4333-8444-555555555555",
      kind: "direct",
      updatedAt: 1,
    } satisfies GatewaySessionRow;
    const decideApproval = vi.fn();
    const context: ApplicationContext = {
      ...createInitializationContext(),
      overlays: {
        snapshot: {
          approvalQueue: [],
          approvalBusy: false,
          approvalCanGrant: true,
          approvalErrors: new Map(),
        },
        decideApproval,
      } as unknown as ApplicationContext["overlays"],
      sessions: createSessionCapabilityFixture({
        state: {
          result: null,
          agentId: "main",
          modelOverrides: {},
          deletedSessions: [],
          loading: false,
          error: null,
          groups: [],
          groupSettings: [],
          sectionOrder: [],
        },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    const state = pane.initialize(context);
    state.sessionKey = host.key;
    pane.paneTitle = "Unrelated pane title";
    const now = Date.now();
    state.chatSessionApprovalQueue = projectSessionApprovalReplay(
      {
        sessionKey: host.key,
        updatedAtMs: now,
        truncated: false,
        approvals: [
          {
            id: "plugin:requester-title",
            status: "pending",
            sourceSessionKey: source.key,
            createdAtMs: now,
            expiresAtMs: now + 60_000,
            urlPath: "/approve/plugin%3Arequester-title",
            presentation: {
              kind: "plugin",
              title: "Review requested action",
              description: "A synthetic child-session request",
              severity: "warning",
              pluginId: "test-plugin",
              toolName: null,
              agentId: "main",
              allowedDecisions: ["allow-once", "deny"],
            },
          },
        ],
      },
      host.key,
    );
    const approval = state.chatSessionApprovalQueue[0]!;
    expect(approval).toMatchObject({
      id: "plugin:requester-title",
      kind: "plugin",
      sourceSessionKey: source.key,
      request: { sessionKey: host.key },
    });
    Object.freeze(approval.request);
    Object.freeze(approval);
    const container = document.createElement("div");
    const redraw = vi.fn(() => {
      pane.render();
      render(renderChat(pane.chatProps!), container);
    });
    state.requestUpdate = redraw;
    const publications: Array<[GatewaySessionRow | undefined, string]> = [
      [undefined, "New session"],
      [
        { ...source, derivedTitle: "Requesting session derived title" },
        "Requesting session derived title",
      ],
      [
        { ...source, displayName: "Requesting session display name" },
        "Requesting session display name",
      ],
      [{ ...source, label: "Requesting session label" }, "Requesting session label"],
      [{ ...source, label: "Renamed requesting session" }, "Renamed requesting session"],
      [undefined, "New session"],
    ];

    try {
      for (const [row, title] of publications) {
        redraw.mockClear();
        pane.applySessionsState({
          ...context.sessions.state,
          result: {
            ts: now,
            path: "",
            count: row ? 2 : 1,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: row ? [host, row] : [host],
          },
        });
        await vi.waitFor(() => expect(redraw).toHaveBeenCalled());
        const card = container.querySelector(".chat-inline-approval .exec-approval-card");
        expect(card?.getAttribute("data-approval-id")).toBe(approval.id);
        expect
          .soft(card?.querySelector('[role="note"]')?.textContent?.trim())
          .toBe(t("execApproval.requestedBySession", { session: title }));
      }
      container.querySelector<HTMLButtonElement>(".exec-approval-actions .primary")!.click();
      expect(decideApproval).toHaveBeenCalledExactlyOnceWith("allow-once", approval.id, approval);
    } finally {
      cancelChatStreamRenderFrame(state);
      render(html``, container);
    }
  });
});
