/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

describe("catalog session open", () => {
  it("releases staged attachment payloads instead of stranding them for the tab", () => {
    const { pane, state } = createTestChatPane({
      client: { request: () => new Promise(() => {}) } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const attachment = registerChatAttachmentPayload({
      attachment: { id: "catalog-staged", mimeType: "image/png" },
      dataUrl: "data:image/png;base64,c3RhZ2Vk",
      file: new File(["staged"], "staged.png", { type: "image/png" }),
    });
    state.chatAttachments = [attachment];

    (
      pane as TestChatPane & {
        openCatalogSession: (key: unknown, state: unknown) => void;
      }
    ).openCatalogSession({ catalogId: "cat-1", hostId: "host-1", threadId: "thread-1" }, state);

    expect(state.chatAttachments).toEqual([]);
    // The payload-store entry must be gone: a retained entry keeps the File
    // and its object URL resident for the whole tab lifetime.
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });
});
