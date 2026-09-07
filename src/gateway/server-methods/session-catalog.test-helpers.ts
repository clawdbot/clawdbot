import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{
    pluginId?: string;
    pluginName?: string;
    provider: SessionCatalogProvider;
    rootDir?: string;
    source?: string;
  }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listSessionEntriesReadOnly: vi.fn<
    (scope?: { agentId?: string; clone?: boolean; projection?: "full" | "list" }) => Array<{
      sessionKey: string;
      entry: {
        createdActor?: { type: "human" | "agent" | "system"; id?: string };
        updatedAt?: number;
      };
    }>
  >(() => []),
  recordSessionStateEvent: vi.fn(),
  upsertSessionUpstreamLink: vi.fn(),
}));
const conversationBindingMocks = vi.hoisted(() => ({
  bindPluginSessionConversation: vi.fn(async (params: { afterBind?: () => Promise<void> }) => {
    await params.afterBind?.();
    return {};
  }),
}));
vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEvent: hoisted.recordSessionStateEvent,
}));

vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLink: hoisted.upsertSessionUpstreamLink,
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: conversationBindingMocks.bindPluginSessionConversation,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly };
});
vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileRole: vi.fn(() => null),
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
const { markPluginRegistryActive } = await import("../../plugins/registry-lifecycle.js");
const { bindPluginRegistryRuntime } = await import("../../plugins/registry-runtime-binding.js");
const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
const { resolveRegisteredCatalogCreateTarget, sessionCatalogHandlers } =
  await import("./session-catalog.js");

export function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

export async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string; connectionSignal?: AbortSignal },
  contextOverrides: Record<string, unknown> = {},
) {
  const pending = startCall(method, params, config, client, contextOverrides);
  await pending.completion;
  return pending.respond;
}

export function startCall(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string; connectionSignal?: AbortSignal },
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers[method]?.({
      params,
      respond,
      client,
      context: { getRuntimeConfig: () => config, ...contextOverrides },
    } as never),
  );
  return { completion, respond };
}

export function resetSessionCatalogTestState() {
  hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
  markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
  hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
  hoisted.listSessionEntriesReadOnly.mockReset();
  hoisted.listSessionEntriesReadOnly.mockReturnValue([]);
  hoisted.recordSessionStateEvent.mockClear();
  hoisted.upsertSessionUpstreamLink.mockClear();
  conversationBindingMocks.bindPluginSessionConversation.mockClear();
}

export {
  bindPluginRegistryRuntime,
  conversationBindingMocks,
  createPluginRuntime,
  hoisted,
  markPluginRegistryActive,
  resolveRegisteredCatalogCreateTarget,
};
export type { PluginRegistry, SessionCatalogProvider };
