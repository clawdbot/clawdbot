/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { makeChatHost, makeRequestMock } from "../../ui/src/pages/chat/chat-host.test-support.ts";
import type { ChatPageHost } from "../../ui/src/pages/chat/chat-state-host.ts";
import {
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../../ui/src/pages/chat/chat-state-refresh.ts";
import { createTestGatewayClient } from "../../ui/src/test-helpers/gateway-client.ts";

it("ignores model rows in chat.metadata until the picker reads models.list", async () => {
  const request = makeRequestMock({
    "chat.metadata": async () => ({
      commands: [],
      models: [{ id: "metadata-model", name: "Metadata Model", provider: "test" }],
    }),
  });
  const host = makeChatHost({
    client: createTestGatewayClient(request),
    sessionKey: "agent:main:main",
  }) as ChatPageHost;

  await refreshChatMetadata(host);

  expect(host.chatModelCatalog).toEqual([]);
  retireChatMetadataRequests(host);
});
