/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createBrowserAnnotationHandoff } from "../../app/browser-annotation-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  BrowserAnnotationDraft,
  BrowserAnnotationEvent,
} from "../../components/browser/browser-annotation.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import {
  closePaneBrowserAnnotations,
  discardStateBrowserAnnotations,
  preparePaneBrowserAnnotations,
  receiveBrowserAnnotation,
  restorePaneBrowserAnnotations,
} from "./chat-pane-browser-annotation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatSplitLayout } from "./split-layout.ts";

function annotation(id: string, modelContext = `Context ${id}`): ChatAttachment {
  return {
    id,
    mimeType: "image/png",
    browserAnnotation: {
      modelContext,
      title: `Page ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

function draft(modelContext: string): BrowserAnnotationDraft {
  return {
    modelContext,
    dataUrl: "data:image/png;base64,aGVsbG8=",
    fileName: "annotated-page.png",
    card: {
      title: "Example",
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

describe("browser annotation admission", () => {
  it("includes the candidate in both the four-card and 8,000-character bounds", () => {
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_000))).toBe(true);
    expect(canAdmitBrowserAnnotation([], "x".repeat(8_001))).toBe(false);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three")],
        "fourth",
      ),
    ).toBe(true);
    expect(
      canAdmitBrowserAnnotation(
        [annotation("one"), annotation("two"), annotation("three"), annotation("four")],
        "fifth",
      ),
    ).toBe(false);
  });

  it("marks an active-pane rejection without allocating or consuming the capture", () => {
    const state = {
      chatAttachments: [
        annotation("one"),
        annotation("two"),
        annotation("three"),
        annotation("four"),
      ],
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const event = new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail: draft("Rejected context"),
      cancelable: true,
    });
    expect(receiveBrowserAnnotation(state, true, event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect((event as BrowserAnnotationEvent).rejection).toBe("limit");
    expect(state.chatAttachments).toHaveLength(4);
  });
});

describe("browser annotation pane teardown", () => {
  it("discards live annotations before clearing a closed pane handoff", () => {
    const calls: string[] = [];
    const pane = {
      paneId: "p1",
      discardBrowserAnnotations: () => calls.push("discard"),
    };
    const root = { querySelectorAll: () => [pane] } as unknown as ParentNode;
    const context = {
      browserAnnotationHandoff: { clearPane: () => calls.push("clear") },
    } as unknown as ApplicationContext;
    const layout = {
      columns: [
        {
          id: "c1",
          panes: [
            { id: "p1", sessionKey: "one" },
            { id: "p2", sessionKey: "two" },
          ],
          paneWeights: [1, 1],
        },
      ],
      columnWeights: [1],
      activePaneId: "p1",
    } satisfies ChatSplitLayout;

    expect(closePaneBrowserAnnotations(context, root, layout, "p1")?.id).toBe("p2");
    expect(calls).toEqual(["discard", "clear"]);
  });

  it("deduplicates current and fallback annotations while preserving ordinary payloads", () => {
    const stored = (attachment: ChatAttachment, payload: string) =>
      registerChatAttachmentPayload({
        attachment,
        dataUrl: payload,
        file: new File([payload], `${attachment.id}.png`, { type: attachment.mimeType }),
      });
    const shared = stored(annotation("shared"), "data:image/png;base64,c2hhcmVk");
    const fallback = stored(annotation("fallback"), "data:image/png;base64,ZmFsbGJhY2s=");
    const ordinary = stored(
      { id: "ordinary", mimeType: "image/png" },
      "data:image/png;base64,b3JkaW5hcnk=",
    );
    const state = {
      chatAttachments: [shared, ordinary],
      chatComposerFallbackByScope: {
        fallback: {
          attachments: [shared, fallback, ordinary],
          message: "",
          sequence: 1,
          storageFailed: false,
        },
      },
    } as unknown as ChatPageHost;

    discardStateBrowserAnnotations(state);

    expect(getChatAttachmentDataUrl(shared)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
    expect(state.chatAttachments).toEqual([ordinary]);
    expect(state.chatComposerFallbackByScope.fallback?.attachments).toEqual([ordinary]);
    releaseChatAttachmentPayload(ordinary.id);
  });

  it("restores route and split-pane annotations only to the exact mounted owner", () => {
    const owner = {} as GatewayBrowserClient;
    const otherOwner = {} as GatewayBrowserClient;
    const handoff = createBrowserAnnotationHandoff();
    const context = { browserAnnotationHandoff: handoff } as unknown as ApplicationContext;
    const ordinary = { id: "ordinary", mimeType: "image/png" } satisfies ChatAttachment;
    const first = annotation("first");
    const second = annotation("second");
    const state = (attachments: ChatAttachment[], sessionKey = "agent:main:one") =>
      ({
        agentsList: { defaultId: "main", mainKey: "main" },
        assistantAgentId: "main",
        chatAttachments: attachments,
        chatComposerFallbackByScope: {},
        hello: null,
        sessionKey,
        settings: { gatewayUrl: "ws://example.test" },
      }) as unknown as ChatPageHost;

    preparePaneBrowserAnnotations(context, "p1", state([ordinary, first]), owner);
    preparePaneBrowserAnnotations(context, "p2", state([second]), owner);

    const mismatched = state([]);
    restorePaneBrowserAnnotations(context, "p1", mismatched, otherOwner);
    expect(mismatched.chatAttachments).toEqual([]);

    const secondRemount = state([ordinary]);
    restorePaneBrowserAnnotations(context, "p2", secondRemount, owner);
    expect(secondRemount.chatAttachments).toEqual([ordinary, second]);
    expect(secondRemount.chatAttachments[1]).toBe(second);
  });
});
