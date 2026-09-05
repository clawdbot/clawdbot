/* @vitest-environment jsdom */
import type { ProgressCard, ProgressCardChangedEvent } from "@openclaw/gateway-protocol";
import { html, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  createGatewayBrowserClientFixture,
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

function createGlobalFeaturePane(
  request: (method: string, params?: unknown) => unknown,
  methods: string[],
) {
  const client = createGatewayBrowserClientFixture({
    request: (method, params) =>
      method === "tasks.list" ? Promise.resolve({ tasks: [] }) : request(method, params),
  });
  const sessions = createSessionCapabilityFixture({
    state: { modelOverrides: {}, result: null, loading: false, error: null },
    reconcile: vi.fn(),
    think: () => undefined,
  });
  const initial = createInitializationContext();
  const live = createSessionContext(client, sessions);
  const context: ApplicationContext = {
    ...initial,
    ...live,
    config: { ...initial.config, current: { ...initial.config.current, ...live.config.current } },
  };
  context.gateway.snapshot.hello = gatewayHelloForMethods(methods);
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  (pane as unknown as { connectedClient: GatewayBrowserClient }).connectedClient = client;
  state.client = client;
  state.connected = true;
  state.hello = context.gateway.snapshot.hello;
  state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
  context.agents.state.agentsList = state.agentsList;
  pane.sessionKey = "global";
  state.sessionKey = "global";
  const select = (agentId: string) => {
    context.agentSelection.set(agentId);
    state.assistantAgentId = agentId;
    state.sessionsResultAgentId = agentId;
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "global", agentId, sessionId: `${agentId}-parent`, kind: "global", updatedAt: 1 },
      ],
    };
    pane.requestUpdate();
  };
  select("research");
  ChatPaneBase.prototype.connectedCallback.call(pane);
  onTestFinished(() => {
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(pane);
    cancelChatStreamRenderFrame(state);
  });
  const emit = (payload: ProgressCardChangedEvent) => {
    const gateway = context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({ type: "event", event: "progressCard.changed", payload, seq: 1 });
  };
  return { pane, select, emit };
}

function globalProgressCard(agentId: string, revision = 1): ProgressCard {
  return {
    sessionKey: `agent:${agentId}:global`,
    revision,
    updatedAt: 1_700_000_000_000 + revision,
    markdown: `${agentId} progress ${revision}`,
    steps: [{ step: `${agentId} work`, status: "completed" }],
  };
}

describe("global chat pane feature ownership", () => {
  it("loads, refreshes and dismisses the selected agent's global progress card", async () => {
    let card: ProgressCard | null = globalProgressCard("research");
    const request = vi.fn(async (method: string) => {
      if (method === "progressCard.put") {
        card = null;
      }
      return { card };
    });
    const { pane, emit } = createGlobalFeaturePane(request, [
      "progressCard.get",
      "progressCard.put",
    ]);
    await pane.updateComplete;
    expect(request).toHaveBeenCalledWith("progressCard.get", {
      sessionKey: "global",
      agentId: "research",
    });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));

    card = globalProgressCard("research", 2);
    emit({ sessionKey: card.sessionKey, revision: card.revision });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);

    const displayedCard = pane.chatProps?.progressCard;
    if (!displayedCard) {
      throw new Error("Expected the displayed progress card");
    }
    pane.chatProps!.onDismissProgressCard!(displayedCard);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toBeNull());
    expect(request).toHaveBeenLastCalledWith("progressCard.put", {
      sessionKey: "global",
      agentId: "research",
      expectedRevision: 2,
    });
  });

  it("keeps Main progress when an old Research response arrives for the same raw global key", async () => {
    const old = createDeferred<{ card: ProgressCard }>();
    const main = globalProgressCard("main");
    let reads = 0;
    const request = vi.fn((method: string) => {
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return ++reads === 1 ? old.promise : Promise.resolve({ card: main });
    });
    const { pane, select, emit } = createGlobalFeaturePane(request, ["progressCard.get"]);
    await pane.updateComplete;
    expect(reads).toBe(1);
    select("main");
    await pane.updateComplete;
    expect(request).toHaveBeenLastCalledWith("progressCard.get", {
      sessionKey: "global",
      agentId: "main",
    });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(main));
    old.resolve({ card: globalProgressCard("research") });
    await old.promise;
    await pane.updateComplete;
    emit({ sessionKey: "agent:research:global", revision: null });
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toEqual(main);
    expect(reads).toBe(2);
  });
});
