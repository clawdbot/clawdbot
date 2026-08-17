/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../pages/chat/attachment-payload-store.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";

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

describe("chat attachment route handoff", () => {
  it("transfers every exact staged attachment object once", () => {
    const owner = {} as GatewayBrowserClient;
    const annotation = storedAttachment("annotation", "image/png", true);
    const ordinary = [
      storedAttachment("image", "image/png", false),
      storedAttachment("file", "application/pdf", false),
      storedAttachment("pasted-text", "text/plain", false),
    ];
    const staged = [ordinary[0]!, annotation, ordinary[1]!, ordinary[2]!];
    const handoff = createChatAttachmentHandoff();
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: staged,
      fallbacks: {},
    });

    const consumed = handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" });
    expect(consumed?.attachments).toEqual(staged);
    expect(consumed?.attachments).not.toBe(staged);
    expect(consumed?.attachments.every((attachment, index) => attachment === staged[index])).toBe(
      true,
    );
    expect(handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" })).toBeNull();
    for (const attachment of ordinary) {
      expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
    }
  });

  it("isolates retained session scopes and releases an exact Gateway-owner mismatch", () => {
    const handoff = createChatAttachmentHandoff();
    const expectedOwner = { gatewayUrl: "ws://first.test" } as GatewayBrowserClient;
    const first = storedAttachment("first-scope", "image/png", true);
    const second = storedAttachment("second-scope", "image/png", true);
    handoff.prepare({
      owner: expectedOwner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [first],
      fallbacks: {},
    });
    handoff.prepare({
      owner: expectedOwner,
      paneId: "p1",
      scopeKey: "agent:main:two",
      attachments: [second],
      fallbacks: {},
    });

    expect(
      handoff.consume({
        owner: { gatewayUrl: "ws://second.test" } as GatewayBrowserClient,
        paneId: "p1",
        scopeKey: "agent:main:two",
      }),
    ).toBeNull();
    expect(getChatAttachmentDataUrl(second)).toBeNull();
    expect(
      handoff.consume({ owner: expectedOwner, paneId: "p1", scopeKey: "agent:main:one" }),
    ).toEqual({ attachments: [first], fallbacks: {}, owner: expectedOwner });
  });

  it("preserves plain payloads across a same-Gateway client replacement", () => {
    const handoff = createChatAttachmentHandoff();
    const previous = { gatewayUrl: "ws://same.test" } as GatewayBrowserClient;
    const replacement = { gatewayUrl: "ws://same.test" } as GatewayBrowserClient;
    const first = storedAttachment("same-name-first", "text/plain", false);
    const annotation = storedAttachment("client-bound", "image/png", true);
    const second = storedAttachment("same-name-second", "text/plain", false);
    const fallbackPlain = storedAttachment("fallback-plain", "text/plain", false);
    const fallbackAnnotation = storedAttachment("fallback-client-bound", "image/png", true);
    first.fileName = second.fileName = "proof.txt";
    handoff.prepare({
      owner: previous,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [first, annotation, second],
      fallbacks: {
        fallback: {
          attachments: [fallbackAnnotation, fallbackPlain],
          message: "retained fallback",
          sequence: 1,
          storageFailed: true,
        },
      },
    });

    expect(
      handoff.consume({ owner: replacement, paneId: "p1", scopeKey: "agent:main:one" }),
    ).toEqual({
      attachments: [first, annotation, second],
      fallbacks: {
        fallback: {
          attachments: [fallbackAnnotation, fallbackPlain],
          message: "retained fallback",
          sequence: 1,
          storageFailed: true,
        },
      },
      owner: previous,
    });
    expect(getChatAttachmentDataUrl(first)).not.toBeNull();
    expect(getChatAttachmentDataUrl(annotation)).not.toBeNull();
    expect(getChatAttachmentDataUrl(second)).not.toBeNull();
    expect(getChatAttachmentDataUrl(fallbackPlain)).not.toBeNull();
    expect(getChatAttachmentDataUrl(fallbackAnnotation)).not.toBeNull();
  });

  it("does not let an empty retained session teardown erase another scope", () => {
    const handoff = createChatAttachmentHandoff();
    const owner = {} as GatewayBrowserClient;
    const annotation = storedAttachment("overlapping-scope", "image/png", true);
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [annotation],
      fallbacks: {},
    });
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "agent:main:two",
      attachments: [],
      fallbacks: {},
    });

    expect(
      handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" })?.attachments,
    ).toEqual([annotation]);
  });

  it("keeps payloads reused by a replacement prepare", () => {
    const owner = {} as GatewayBrowserClient;
    const retained = storedAttachment("replacement-retained", "image/png", false);
    const removed = storedAttachment("replacement-removed", "image/png", false);
    const handoff = createChatAttachmentHandoff();
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "one",
      attachments: [retained, removed],
      fallbacks: {},
    });
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: "one",
      attachments: [retained],
      fallbacks: {},
    });

    expect(getChatAttachmentDataUrl(retained)).not.toBeNull();
    expect(getChatAttachmentDataUrl(removed)).toBeNull();
    expect(handoff.consume({ owner, paneId: "p1", scopeKey: "one" })?.attachments).toEqual([
      retained,
    ]);
  });

  it("bounds abandoned entries and releases pane-clear and application disposal", () => {
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const oversized = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`oversized-${index}`, "image/png", false),
    );
    handoff.prepare({
      owner,
      paneId: "oversized",
      scopeKey: "oversized",
      attachments: oversized,
      fallbacks: {},
    });
    expect(
      handoff.consume({ owner, paneId: "oversized", scopeKey: "oversized" })?.attachments,
    ).toEqual(oversized);
    expect(getChatAttachmentDataUrl(oversized[32]!)).not.toBeNull();

    const annotations = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`bounded-${index}`, "image/png", true),
    );
    annotations.forEach((annotation, index) =>
      handoff.prepare({
        owner,
        paneId: `p${index}`,
        scopeKey: `scope-${index}`,
        attachments: [annotation],
        fallbacks: {},
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
    const handoff = createChatAttachmentHandoff();
    const annotation = storedAttachment("late", "image/png", true);
    handoff.dispose();

    handoff.prepare({
      owner: {} as GatewayBrowserClient,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [annotation],
      fallbacks: {},
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
