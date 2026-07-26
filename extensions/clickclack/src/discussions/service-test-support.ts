import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import type { ClickClackClient } from "../http-client.js";
import type { ClickClackChannel, ClickClackMessage, CoreConfig } from "../types.js";
import { discussionExternalRef } from "./naming.js";
import { ClickClackDiscussionService } from "./service.js";

const TEST_INSTALLATION_ID = "11111111-2222-4333-8444-555555555555";
const TEST_BINDING_GENERATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const TEST_DESTINATION_IDENTITY = "https://clickclack.example\0wsp_team";
export const MANAGED_CONTRACT_FIELDS = {
  external_managed: false,
  external_ref: "",
  external_url: "",
  sidebar_section: "",
};

function createMemoryStore<T>(): PluginStateSyncKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    register(key, value) {
      values.set(key, { value, createdAt: Date.now() });
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    lookup: (key) => values.get(key)?.value,
    consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () =>
      Array.from(values, ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      })),
    clear: () => values.clear(),
  };
}

export function discussionConfig(): CoreConfig {
  return {
    channels: {
      clickclack: {
        enabled: true,
        baseUrl: "https://clickclack.example",
        token: "test-token",
        workspace: "main",
        discussions: {
          enabled: true,
          workspace: "team",
          controlUrlBase: "https://control.example/control/",
          section: "Sessions",
        },
      },
    },
  };
}

export function createHarness(
  entry: { sessionId?: string; label?: string; category?: string; archivedAt?: number } | undefined,
  options: { bindingGenerationFactory?: () => string } = {},
) {
  let sessionEntry = entry;
  const config = discussionConfig();
  const store = createMemoryStore<unknown>();
  const generationStore = createMemoryStore<unknown>();
  const revokedStore = createMemoryStore<unknown>();
  const runtime = createPluginRuntimeMock({
    config: { current: vi.fn(() => config) },
    state: {
      openSyncKeyedStore: vi.fn((storeOptions: { namespace: string }) => {
        if (storeOptions.namespace === "discussion-binding-generations") {
          return generationStore;
        }
        if (storeOptions.namespace === "discussion-revoked-channels") {
          return revokedStore;
        }
        return store;
      }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"],
    },
    agent: {
      session: {
        getSessionEntry: vi.fn(() =>
          sessionEntry ? { sessionId: "session-id", updatedAt: 1, ...sessionEntry } : undefined,
        ),
      },
    },
  });
  const createChannel = vi.fn(
    async (_workspaceId: string, input: Parameters<ClickClackClient["createChannel"]>[1]) => ({
      id: "chn_discussion",
      route_id: "discussion-route",
      workspace_id: "wsp_team",
      ...input,
      kind: "public",
      created_at: "2026-07-19T00:00:00.000Z",
    }),
  );
  const updateChannel = vi.fn(
    async (_channelId: string, patch: Parameters<ClickClackClient["updateChannel"]>[1]) => ({
      id: "chn_discussion",
      route_id: "discussion-route",
      workspace_id: "wsp_team",
      name: patch.name ?? "release-planning",
      kind: "public",
      external_managed: patch.external_managed ?? true,
      external_ref: patch.external_ref ?? "agent:main:main",
      external_url:
        patch.external_url ?? "https://control.example/control/chat?session=agent%3Amain%3Amain",
      sidebar_section: patch.sidebar_section ?? "Projects",
      archived: patch.archived ?? false,
      created_at: "2026-07-19T00:00:00.000Z",
    }),
  );
  const latestChannelMessages = vi.fn<
    (
      channelId: string,
      limit: number,
    ) => Promise<{ messages: ClickClackMessage[]; truncated: boolean }>
  >(async () => ({ messages: [], truncated: false }));
  const channels = vi.fn<() => Promise<ClickClackChannel[]>>(async () => [
    {
      id: "chn_general",
      route_id: "general-route",
      workspace_id: "wsp_team",
      name: "general",
      kind: "public",
      ...MANAGED_CONTRACT_FIELDS,
      created_at: "2026-07-19T00:00:00.000Z",
    },
  ]);
  const client = {
    workspaces: vi.fn(async () => [
      {
        id: "wsp_team",
        route_id: "team-route",
        slug: "team",
        name: "Team",
        created_at: "2026-07-19T00:00:00.000Z",
      },
    ]),
    createChannel,
    updateChannel,
    latestChannelMessages,
    channels,
  } as unknown as ClickClackClient;
  const service = new ClickClackDiscussionService(runtime, {
    clientFactory: () => client,
    installationId: TEST_INSTALLATION_ID,
    bindingGenerationFactory: options.bindingGenerationFactory ?? (() => TEST_BINDING_GENERATION),
    startTimer: false,
  });
  return {
    runtime,
    service,
    client,
    createChannel,
    updateChannel,
    latestChannelMessages,
    channels,
    config,
    store,
    generationStore,
    revokedStore,
    setSessionEntry(value: typeof sessionEntry) {
      sessionEntry = value;
    },
  };
}

export function testExternalRef(sessionKey: string, sessionId = "session-id"): string {
  return discussionExternalRef(
    TEST_INSTALLATION_ID,
    sessionKey,
    sessionId,
    TEST_DESTINATION_IDENTITY,
    TEST_BINDING_GENERATION,
  );
}
