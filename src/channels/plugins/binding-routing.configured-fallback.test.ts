// Route-level proof for the stale-binding guard: chains the two resolvers the way
// channel plugins do (runtime binding first, configured binding when none applies)
// and asserts a configured ACP binding is actually selected once a stale runtime
// record is discarded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  testing,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "./binding-routing.js";
import { ensureConfiguredBindingBuiltinsRegistered } from "./configured-binding-builtins.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentConfig: resolveAgentConfigMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
}));

vi.mock("./index.js", () => ({
  getLoadedChannelPlugin: getLoadedChannelPluginMock,
}));

vi.mock("../../config/sessions/session-accessor.js", { spy: true });

const CONVERSATION_ID = "room-1";
const STALE_SESSION_KEY = "agent:main:demo:default:direct:room-1";

function createConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "main" }, { id: "review" }] },
    bindings: [
      {
        type: "acp",
        agentId: "review",
        match: {
          channel: "demo",
          accountId: "default",
          peer: { kind: "channel", id: CONVERSATION_ID },
        },
        acp: { backend: "acpx" },
      },
    ],
  } as unknown as OpenClawConfig;
}

function createDemoAcpPlugin() {
  return {
    id: "demo",
    bindings: {
      compileConfiguredBinding: vi.fn(({ conversationId }: { conversationId: string }) => ({
        conversationId,
      })),
      matchInboundConversation: vi.fn(
        ({
          compiledBinding,
          conversationId,
        }: {
          compiledBinding: { conversationId: string };
          conversationId: string;
        }) =>
          compiledBinding.conversationId === conversationId
            ? { conversationId, matchPriority: 2 }
            : null,
      ),
    },
  };
}

function createRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "demo",
    accountId: "default",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
}

/** The catch-all-created runtime binding described in #115354. */
function registerRuntimeBinding(targetSessionKey: string): void {
  const record: SessionBindingRecord = {
    bindingId: "binding-1",
    targetSessionKey,
    targetKind: "session",
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: CONVERSATION_ID,
    },
    status: "active",
    boundAt: 1,
  };
  registerSessionBindingAdapter({
    channel: "demo",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: () => record,
    touch: () => {},
  });
}

/**
 * Mirrors the channel-plugin ordering: apply the runtime binding, and fall through
 * to the configured binding only when no runtime record is authoritative.
 */
function resolveChannelRoute(cfg: OpenClawConfig) {
  const conversation = {
    channel: "demo",
    accountId: "default",
    conversationId: CONVERSATION_ID,
  };
  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route: createRoute(),
    conversation,
  });
  if (runtimeRoute.bindingRecord) {
    return { via: "runtime" as const, route: runtimeRoute.route, configuredBinding: null };
  }
  const configuredRoute = resolveConfiguredBindingRoute({
    cfg,
    route: runtimeRoute.route,
    conversation,
  });
  return {
    via: "configured" as const,
    route: configuredRoute.route,
    configuredBinding: configuredRoute.bindingResolution,
  };
}

describe("configured binding fallback after a stale runtime binding", () => {
  beforeEach(() => {
    testing.resetSessionBindingAdaptersForTests();
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    getLoadedChannelPluginMock.mockReset().mockReturnValue(createDemoAcpPlugin());
    ensureConfiguredBindingBuiltinsRegistered();
  });

  it("selects the configured ACP binding when the runtime target session is gone", () => {
    // Session store cannot resolve the catch-all's target: the stale state from #115354.
    vi.mocked(loadSessionEntryReadOnly).mockReturnValue(undefined);
    registerRuntimeBinding(STALE_SESSION_KEY);

    const result = resolveChannelRoute(createConfig());

    expect(result.via).toBe("configured");
    expect(result.configuredBinding).not.toBeNull();
    // The ACP binding owns the session key, so routing lands on the `review` agent
    // instead of the catch-all's `main`.
    expect(result.route.agentId).toBe("review");
    expect(result.route.matchedBy).toBe("binding.channel");
    expect(result.route.sessionKey).not.toBe(STALE_SESSION_KEY);
  });

  it("keeps honoring a live runtime binding over the configured binding", () => {
    // Documented precedence is unchanged by the guard: a resolvable target still wins.
    vi.mocked(loadSessionEntryReadOnly).mockReturnValue({} as SessionEntry);
    registerRuntimeBinding(STALE_SESSION_KEY);

    const result = resolveChannelRoute(createConfig());

    expect(result.via).toBe("runtime");
    expect(result.route.sessionKey).toBe(STALE_SESSION_KEY);
    expect(result.route.agentId).toBe("main");
  });
});
