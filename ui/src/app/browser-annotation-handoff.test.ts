/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../pages/chat/attachment-payload-store.ts";
import { createBrowserAnnotationHandoff } from "./browser-annotation-handoff.ts";

const registeredIds = new Set<string>();

function storedAttachment(id: string, mimeType: string, annotated: boolean): ChatAttachment {
  const attachment: ChatAttachment = {
    id,
    mimeType,
    ...(annotated
      ? {
          browserAnnotation: {
            modelContext: `Context ${id}`,
            title: `Page ${id}`,
            displayUrl: "example.com",
            markedRegionCount: 1,
            inspectedElement: false,
          },
        }
      : {}),
  };
  registeredIds.add(id);
  return registerChatAttachmentPayload({
    attachment,
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

afterEach(() => {
  for (const id of registeredIds) {
    releaseChatAttachmentPayload(id);
  }
  registeredIds.clear();
});

describe("browser annotation route handoff", () => {
  it("transfers exact annotation objects once without transferring ordinary attachments", () => {
    const owner = {} as GatewayBrowserClient;
    const annotation = storedAttachment("annotation", "image/png", true);
    const ordinary = [
      storedAttachment("image", "image/png", false),
      storedAttachment("file", "application/pdf", false),
      storedAttachment("pasted-text", "text/plain", false),
    ];
    const handoff = createBrowserAnnotationHandoff();
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [ordinary[0]!, annotation, ordinary[1]!, ordinary[2]!],
    });

    const consumed = handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" });
    expect(consumed).toEqual([annotation]);
    expect(consumed?.[0]).toBe(annotation);
    expect(handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" })).toBeNull();
    for (const attachment of ordinary) {
      expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
    }
  });

  it("releases a reused pane on session or Gateway-owner mismatch", () => {
    const cases = [
      { ownerMatches: false, scopeKey: "agent:main:one" },
      { ownerMatches: true, scopeKey: "agent:main:two" },
    ];
    for (const { ownerMatches, scopeKey } of cases) {
      const handoff = createBrowserAnnotationHandoff();
      const expectedOwner = {} as GatewayBrowserClient;
      const annotation = storedAttachment(
        `mismatch-${ownerMatches}-${scopeKey}`,
        "image/png",
        true,
      );
      handoff.prepare({
        owner: expectedOwner,
        paneId: "p1",
        scopeKey: "agent:main:one",
        attachments: [annotation],
      });

      expect(
        handoff.consume({
          owner: ownerMatches ? expectedOwner : ({} as GatewayBrowserClient),
          paneId: "p1",
          scopeKey,
        }),
      ).toBeNull();
      expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    }
  });

  it("bounds abandoned entries and releases pane-clear and application disposal", () => {
    const owner = {} as GatewayBrowserClient;
    const handoff = createBrowserAnnotationHandoff();
    const oversized = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`oversized-${index}`, "image/png", true),
    );
    handoff.prepare({ owner, paneId: "oversized", scopeKey: "oversized", attachments: oversized });
    expect(getChatAttachmentDataUrl(oversized[32]!)).toBeNull();

    const annotations = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`bounded-${index}`, "image/png", true),
    );
    annotations.forEach((annotation, index) =>
      handoff.prepare({
        owner,
        paneId: `p${index}`,
        scopeKey: `scope-${index}`,
        attachments: [annotation],
      }),
    );

    expect(getChatAttachmentDataUrl(annotations[0]!)).toBeNull();
    expect(getChatAttachmentDataUrl(annotations[1]!)).not.toBeNull();
    handoff.clearPane("p1");
    expect(getChatAttachmentDataUrl(annotations[1]!)).toBeNull();
    handoff.dispose();
    expect(getChatAttachmentDataUrl(annotations[32]!)).toBeNull();
  });

  it("releases a late prepare after application disposal instead of restaging it", () => {
    const handoff = createBrowserAnnotationHandoff();
    const annotation = storedAttachment("late", "image/png", true);
    handoff.dispose();

    handoff.prepare({
      owner: {} as GatewayBrowserClient,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [annotation],
    });

    expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    expect(
      handoff.consume({
        owner: {} as GatewayBrowserClient,
        paneId: "p1",
        scopeKey: "agent:main:one",
      }),
    ).toBeNull();
  });
});
