import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestMock,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatComposerMemoryFallback } from "./chat-state-host.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

type RequestHandlers = Record<string, unknown>;

export function makeRequestMock(handlers: RequestHandlers = {}): GatewayRequestMock {
  return createGatewayRequestMock((method: string, params?: unknown) => {
    if (!Object.hasOwn(handlers, method)) {
      // Keep unrelated Gateway traffic inert so each test declares only the responses it observes.
      return Promise.resolve({});
    }
    try {
      const handler = handlers[method];
      const response = typeof handler === "function" ? handler(params) : handler;
      return Promise.resolve(response);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type RequestMock = ReturnType<typeof makeRequestMock>;

type TestChatHost = Omit<ChatHost, "settings"> & {
  applySettings: (patch: Partial<UiSettings>) => void;
  basePath: string;
  resourceBasePath: string;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  chatComposerFallbackByScope: Record<string, ChatComposerMemoryFallback>;
  chatModelCatalog: ModelCatalogEntry[];
  chatModelSwitchPromises?: Record<string, Promise<boolean>>;
  sessionsError?: string | null;
  sessionsResultAgentId?: string | null;
  sessionsArchivedFilter?: "active" | "archived" | "all";
  password?: string;
  pendingSettingsPatches?: Record<string, Promise<boolean>>;
  settings: Pick<UiSettings, "lastActiveSessionKey"> & Partial<UiSettings>;
};

function createPendingSettingsSessionCapability(
  sessions: ChatHost["sessions"],
  pendingSettingsPatches: Record<string, Promise<boolean>>,
): ChatHost["sessions"] {
  const pendingBySession = new Map(Object.entries(pendingSettingsPatches));
  const wrapped = Object.create(sessions) as ChatHost["sessions"];
  wrapped.patch = async (sessionKey, patch, options) => {
    const pendingPatch = pendingBySession.get(sessionKey);
    if (!pendingPatch) {
      return sessions.patch(sessionKey, patch, options);
    }
    pendingBySession.delete(sessionKey);
    if (!(await pendingPatch)) {
      return null;
    }
    return {
      ok: true,
      path: "",
      key: sessionKey,
      entry: { sessionId: "pending-settings-test" },
    };
  };
  return wrapped;
}

type TestChatHostWithRequest = TestChatHost & { request: RequestMock };
type MakeHostOverrides = Partial<Omit<TestChatHost, "settings">> & {
  requestHandlers?: RequestHandlers;
  settings?: Partial<UiSettings>;
};

export function makeChatHost(
  overrides: MakeHostOverrides & { requestHandlers: RequestHandlers },
): TestChatHostWithRequest;
export function makeChatHost(overrides?: MakeHostOverrides): TestChatHost;
export function makeChatHost(
  overrides?: MakeHostOverrides,
): TestChatHost | TestChatHostWithRequest {
  const { requestHandlers, ...hostOverrides } = overrides ?? {};
  const request = requestHandlers ? makeRequestMock(requestHandlers) : undefined;
  const settings = { lastActiveSessionKey: "", ...hostOverrides.settings };
  const renderLifecycle: RenderLifecycle = {
    invalidate: vi.fn(),
    afterCommit: (effect) => {
      let active = true;
      renderLifecycle.invalidate();
      queueMicrotask(() => {
        if (active) {
          effect(() => undefined);
        }
      });
      return () => {
        active = false;
      };
    },
  };
  const host = {
    client: request ? createTestGatewayClient(request) : null,
    chatMessages: [],
    chatDisplayedLeafEntryId: undefined,
    chatStream: null,
    chatStreamSegments: [],
    chatToolMessages: [],
    connected: true,
    connectionEpoch: 0,
    chatLoading: false,
    chatMessage: "",
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatAttachments: [],
    chatComposerFallbackByScope: {},
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStreamStartedAt: null,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    resourceBasePath: "",
    hello: sessionMutationGatewayHello(),
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsError: null,
    sessionsArchivedFilter: "active" as const,
    chatModelsLoading: false,
    chatMetadataRequestVersion: 0,
    chatModelCatalog: [],
    chatModelCatalogError: null,
    refreshSessionsAfterChat: new Map(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    renderLifecycle,
    querySelector: () => null,
    chatScrollCommitCleanup: null,
    chatScrollFrame: null,
    chatScrollGuardFrame: null,
    chatScrollGeneration: 0,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    applySettings: vi.fn((patch: Partial<UiSettings>) => {
      // Chat pages own display/layout settings; active-session persistence belongs to pane bindings.
      const next = { ...settings, ...patch };
      Object.assign(settings, {
        chatShowThinking: next.chatShowThinking,
        chatShowToolCalls: next.chatShowToolCalls,
        chatPersistCommentary: next.chatPersistCommentary,
        chatSendShortcut: next.chatSendShortcut,
      });
    }),
    ...hostOverrides,
    settings,
  };
  const sessions =
    hostOverrides.sessions ??
    createSessionCapability({
      snapshot: {
        client: host.client,
        phase: host.connected ? "connected" : "reconnecting",
        hello: host.hello,
        sessionKey: host.sessionKey,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
  for (const session of host.sessionsResult?.sessions ?? []) {
    sessions.reconcile(session, host.sessionsResult?.defaults, {
      selectedGlobalAgentId: host.assistantAgentId,
      archivedFilter: host.sessionsArchivedFilter,
    });
  }
  const pendingSettingsPatches = hostOverrides.pendingSettingsPatches;
  const resolvedSessions = pendingSettingsPatches
    ? createPendingSettingsSessionCapability(sessions, pendingSettingsPatches)
    : sessions;
  const resolvedHost = { ...host, sessions: resolvedSessions } as TestChatHost;
  for (const sessionKey of Object.keys(pendingSettingsPatches ?? {})) {
    void patchChatSessionSettings(resolvedHost, sessionKey, {}).catch(() => undefined);
  }
  return request ? Object.assign(resolvedHost, { request }) : resolvedHost;
}
