import {
  parsePluginBindingApprovalCustomId,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "openclaw/plugin-sdk/conversation-runtime";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { vi, type Mock } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyMock = Mock<DispatchReplyWithBufferedBlockDispatcherFn>;

type DiscordComponentRuntimeMocks = {
  buildPluginBindingResolvedTextMock: UnknownMock;
  dispatchPluginInteractiveHandlerMock: AsyncUnknownMock;
  dispatchReplyMock: DispatchReplyMock;
  enqueueSystemEventMock: UnknownMock;
  readAllowFromStoreMock: AsyncUnknownMock;
  readSessionUpdatedAtMock: UnknownMock;
  recordInboundSessionMock: AsyncUnknownMock;
  resolveStorePathMock: UnknownMock;
  resolvePluginConversationBindingApprovalMock: AsyncUnknownMock;
  upsertPairingRequestMock: AsyncUnknownMock;
};

const runtimeMocks = vi.hoisted(
  (): DiscordComponentRuntimeMocks => ({
    buildPluginBindingResolvedTextMock: vi.fn(),
    dispatchPluginInteractiveHandlerMock: vi.fn(),
    dispatchReplyMock: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(),
    enqueueSystemEventMock: vi.fn(),
    readAllowFromStoreMock: vi.fn(),
    readSessionUpdatedAtMock: vi.fn(),
    recordInboundSessionMock: vi.fn(),
    resolveStorePathMock: vi.fn(),
    resolvePluginConversationBindingApprovalMock: vi.fn(),
    upsertPairingRequestMock: vi.fn(),
  }),
);

export const readAllowFromStoreMock: AsyncUnknownMock = runtimeMocks.readAllowFromStoreMock;
export const dispatchPluginInteractiveHandlerMock: AsyncUnknownMock =
  runtimeMocks.dispatchPluginInteractiveHandlerMock;
export const dispatchReplyMock: DispatchReplyMock = runtimeMocks.dispatchReplyMock;
export const enqueueSystemEventMock: UnknownMock = runtimeMocks.enqueueSystemEventMock;
export const upsertPairingRequestMock: AsyncUnknownMock = runtimeMocks.upsertPairingRequestMock;
export const recordInboundSessionMock: AsyncUnknownMock = runtimeMocks.recordInboundSessionMock;
export const readSessionUpdatedAtMock: UnknownMock = runtimeMocks.readSessionUpdatedAtMock;
export const resolveStorePathMock: UnknownMock = runtimeMocks.resolveStorePathMock;
const resolvePluginConversationBindingApprovalMock: AsyncUnknownMock =
  runtimeMocks.resolvePluginConversationBindingApprovalMock;
const buildPluginBindingResolvedTextMock: UnknownMock =
  runtimeMocks.buildPluginBindingResolvedTextMock;

async function readStoreAllowFromForDmPolicy(params: {
  provider: string;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
}) {
  if (params.shouldRead === false || params.dmPolicy === "allowlist") {
    return [];
  }
  return await readAllowFromStoreMock(params.provider, params.accountId);
}

vi.mock("../monitor/agent-components-helpers.runtime.js", () => {
  return {
    readStoreAllowFromForDmPolicy,
    resolvePinnedMainDmOwnerFromAllowlist,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("../monitor/agent-components.runtime.js", () => {
  return {
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      buildPluginBindingResolvedTextMock(...args),
    createReplyReferencePlanner: vi.fn(
      (params: {
        existingId?: string;
        hasReplied?: boolean;
        replyToMode?: "off" | "first" | "all" | "batched";
        startId?: string;
      }) => {
        let hasReplied = params.hasReplied ?? false;
        let nextId = params.existingId ?? params.startId;
        return {
          hasReplied() {
            return hasReplied;
          },
          markSent() {
            hasReplied = true;
          },
          use() {
            if (params.replyToMode === "off") {
              return undefined;
            }
            if (isSingleUseReplyToMode(params.replyToMode ?? "off") && hasReplied) {
              return undefined;
            }
            const value = nextId;
            hasReplied = true;
            nextId = undefined;
            return value;
          },
        };
      },
    ),
    dispatchPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyMock,
    finalizeInboundContext: vi.fn((ctx) => ctx),
    parsePluginBindingApprovalCustomId,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
    resolveChunkMode: vi.fn(() => "sentences"),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      resolvePluginConversationBindingApprovalMock(...args),
    resolveTextChunkLimit: vi.fn(() => 2000),
  };
});

vi.mock("../interactive-dispatch.js", () => {
  return {
    dispatchDiscordPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  };
});

vi.mock("../monitor/agent-components.deps.runtime.js", () => {
  return {
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
    readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAtMock(...args),
    resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
  };
});

vi.mock("../interactive-dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../interactive-dispatch.js")>(
    "../interactive-dispatch.js",
  );
  return {
    ...actual,
    dispatchDiscordPluginInteractiveHandler: (...args: unknown[]) =>
      dispatchPluginInteractiveHandlerMock(...args),
  };
});

export function resetDiscordComponentRuntimeMocks() {
  dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
    matched: false,
    handled: false,
    duplicate: false,
  });
  dispatchReplyMock.mockClear();
  enqueueSystemEventMock.mockClear();
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
  resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
  resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
    status: "approved",
    binding: {
      bindingId: "binding-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      channel: "discord",
      accountId: "default",
      conversationId: "user:123456789",
      boundAt: Date.now(),
    },
    request: {
      id: "approval-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      requestedAt: Date.now(),
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:123456789",
      },
    },
    decision: "allow-once",
  });
  buildPluginBindingResolvedTextMock.mockReset().mockReturnValue("Binding approved.");
}
