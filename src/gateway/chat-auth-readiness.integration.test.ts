/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { makeChatHost, makeRequestMock } from "../../ui/src/pages/chat/chat-host.test-support.ts";
import { handlePageGatewayEvent } from "../../ui/src/pages/chat/chat-state-events.ts";
import type { ChatPageHost } from "../../ui/src/pages/chat/chat-state-host.ts";
import {
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../../ui/src/pages/chat/chat-state-refresh.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";
import { waitForFast } from "../../ui/src/test-helpers/wait-for.ts";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionModelSelection } from "../model-picker/apply-session-model-selection.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

it("refreshes a retained pane from a persisted profile-only selection through the Gateway lifecycle broadcaster", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    // The picker supplies prepared capabilities; omission would start unrelated catalog discovery.
    const model = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Model",
      reasoning: false,
    };
    const sessionKey = "agent:main:profile";
    const otherKey = "agent:main:other";
    const entry = {
      sessionId: "profile-session",
      updatedAt: 1,
      providerOverride: model.provider,
      modelOverride: model.id,
      modelOverrideSource: "user" as const,
      modelOverrideRouteResolution: "resolved" as const,
      authProfileOverride: "anthropic:missing",
      authProfileOverrideSource: "user" as const,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: otherKey },
      { ...entry, sessionId: "other-session" },
    );
    const request = makeRequestMock({
      "chat.metadata": async (params: unknown) => {
        const selected = loadGatewaySessionEntryReadOnly(
          (params as { sessionKey: string }).sessionKey,
          { agentId: "main" },
        ).entry;
        const available = selected?.authProfileOverride === "anthropic:restored";
        return {
          commands: [],
          models: [
            { ...model, available, ...(available ? {} : { unavailableReason: "missing-auth" }) },
          ],
        };
      },
      "sessions.list": async () => ({ sessions: [], defaults: {}, count: 0, path: "", ts: 0 }),
    });
    const client = createTestGatewayClient(request);
    const retained = makeChatHost({
      sessionKey,
      chatMessage: "Keep this draft",
      client,
    }) as ChatPageHost;
    const sibling = makeChatHost({ sessionKey: otherKey, client }) as ChatPageHost;
    await refreshChatMetadata(retained);
    await refreshChatMetadata(sibling);
    expect(retained.chatModelCatalog[0]?.available).toBe(false);
    const transcript = retained.chatMessages;
    const unsubscribe = onSessionLifecycleEvent(
      createLifecycleEventBroadcastHandler({
        sessionEventSubscribers: { getAll: () => new Set(["reader"]) },
        chatAbortControllers: new Map(),
        broadcastToConnIds: (event, payload) => {
          handlePageGatewayEvent(retained, { type: "event", event, payload });
          handlePageGatewayEvent(sibling, { type: "event", event, payload });
        },
      }),
    );
    try {
      await expect(
        applySessionModelSelection({
          cfg: getRuntimeConfig(),
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          sessionEntry: entry,
          sessionStore: { [sessionKey]: entry },
          currentProvider: model.provider,
          currentModel: model.id,
          defaultProvider: model.provider,
          defaultModel: model.id,
          modelCatalog: [model],
          canPersistStickyModelSelection: false,
          markLiveSwitchPending: true,
          request: {
            provider: model.provider,
            model: model.id,
            isDefault: false,
            profileOverride: "anthropic:restored",
            runtime: { kind: "unchanged" },
          },
        }),
      ).resolves.toMatchObject({ status: "applied", changed: true });
      await waitForFast(() => expect(retained.chatModelCatalog[0]?.available).toBe(true));
      expect(sibling.chatModelCatalog[0]?.available).toBe(false);
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(3);
      expect(retained.chatMessage).toBe("Keep this draft");
      expect(retained.chatMessages).toBe(transcript);
    } finally {
      unsubscribe();
      retireChatMetadataRequests(retained);
      retireChatMetadataRequests(sibling);
    }
  });
});
