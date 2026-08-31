/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { retainChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import type { ChatComposerMemoryFallback, ChatPageHost } from "./chat-state-host.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";

function storedAttachment(id: string, mimeType = "image/png"): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType },
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

function globalHost(
  fallbacks: Record<string, ChatComposerMemoryFallback>,
  attachments: ChatAttachment[] = [],
): ChatPageHost {
  return {
    agentsList: { defaultId: "main", mainKey: "main" },
    assistantAgentId: "main",
    chatAttachments: attachments,
    chatComposerFallbackByScope: fallbacks,
    hello: null,
    sessionKey: "global",
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

describe("chat composer memory fallback adoption", () => {
  it("releases losing sibling fallback payloads when adoption drops them", () => {
    const losing = storedAttachment("losing-sibling-attachment");
    const winning = storedAttachment("winning-attachment");
    const scope = { sessionKey: "global", agentId: "main" } as const;
    const scopeKey = storedChatOutboxScopeKey(scope);
    const bareGlobalKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    const host = globalHost({
      [bareGlobalKey]: {
        awaitingDefaults: true,
        message: "older sibling draft",
        attachments: [losing],
        storageFailed: true,
        sequence: 1,
      },
      [scopeKey]: {
        message: "newest draft",
        attachments: [winning],
        storageFailed: true,
        sequence: 2,
      },
    });

    const ownership = retainChatComposerMemoryFallback(host, scope, {
      message: "newest draft",
      attachments: [winning],
    });

    expect(ownership).toEqual({ sequence: 2 });
    expect(Object.keys(host.chatComposerFallbackByScope)).toEqual([scopeKey]);
    // The losing sibling was dropped for good: its payload-store entry must be
    // released with it, while the adopted fallback's payload stays available.
    expect(getChatAttachmentDataUrl({ id: losing.id, mimeType: losing.mimeType })).toBeNull();
    expect(getChatAttachmentDataUrl({ id: winning.id, mimeType: winning.mimeType })).toBe(
      "data:image/png;base64,winning-attachment",
    );
  });

  it("keeps payloads shared with the live composer when a sibling is dropped", () => {
    const shared = storedAttachment("shared-with-composer");
    const scope = { sessionKey: "global", agentId: "main" } as const;
    const scopeKey = storedChatOutboxScopeKey(scope);
    const bareGlobalKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    const host = globalHost(
      {
        [bareGlobalKey]: {
          awaitingDefaults: true,
          message: "older sibling draft",
          attachments: [shared],
          storageFailed: true,
          sequence: 1,
        },
        [scopeKey]: {
          message: "newest draft",
          attachments: [],
          storageFailed: true,
          sequence: 2,
        },
      },
      [shared],
    );

    retainChatComposerMemoryFallback(host, scope, {
      message: "newest draft",
      attachments: [],
    });

    expect(getChatAttachmentDataUrl({ id: shared.id, mimeType: shared.mimeType })).toBe(
      "data:image/png;base64,shared-with-composer",
    );
  });
});
