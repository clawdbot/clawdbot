/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  closeStagedPane,
  discardStateStagedAttachments,
  preparePaneStagedAttachments,
  replacePaneStagedAttachmentGatewayOwner,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveStoredChatOutboxScope, storedChatOutboxScopeKey } from "./composer-persistence.ts";
import type { ChatSplitLayout } from "./split-layout.ts";

function storedAttachment(id: string, mimeType = "image/png"): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType },
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

function state(attachments: ChatAttachment[], sessionKey = "agent:main:one") {
  return {
    agentsList: { defaultId: "main", mainKey: "main" },
    assistantAgentId: "main",
    chatAttachments: attachments,
    chatComposerFallbackByScope: {},
    hello: null,
    sessionKey,
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

describe("staged chat attachment pane handoff", () => {
  it("discards a mounted package before clearing a closed pane handoff", () => {
    const calls: string[] = [];
    const root = {
      querySelectorAll: () => [
        { paneId: "p1", discardStagedAttachments: () => calls.push("discard-one") },
        { paneId: "p1", discardStagedAttachments: () => calls.push("discard-two") },
        { paneId: "p2", discardStagedAttachments: () => calls.push("wrong-pane") },
      ],
    } as unknown as ParentNode;
    const context = {
      chatAttachmentHandoff: { clearPane: () => calls.push("clear") },
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

    expect(closeStagedPane(context, root, layout, "p1")?.id).toBe("p2");
    expect(calls).toEqual(["discard-one", "discard-two", "clear"]);
  });

  it("does not restage a closed pane when its id is reused after disconnect", () => {
    const owner = {} as GatewayBrowserClient;
    const { pane, state: current } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.paneId = "p2";
    const fallback = storedAttachment("closed-fallback");
    current.chatComposerFallbackByScope = {
      fallback: {
        attachments: [fallback],
        message: "closed pane draft",
        sequence: 1,
        storageFailed: false,
      },
    };
    const root = { querySelectorAll: () => [pane] } as unknown as ParentNode;
    const layout = {
      columns: [
        {
          id: "c1",
          panes: [
            { id: "p1", sessionKey: "one" },
            { id: "p2", sessionKey: current.sessionKey },
          ],
          paneWeights: [1, 1],
        },
      ],
      columnWeights: [1],
      activePaneId: "p2",
    } satisfies ChatSplitLayout;
    const scopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(current, current.sessionKey),
    );

    closeStagedPane(pane.context, root, layout, pane.paneId);
    const lateAttachment = storedAttachment("late-close-completion");
    current.chatAttachments.push(lateAttachment);
    pane.disconnectedCallback();

    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(getChatAttachmentDataUrl(lateAttachment)).toBeNull();
    expect(
      pane.context.chatAttachmentHandoff.consume({
        owner,
        paneId: "p2",
        scopeKey,
      }),
    ).toBeNull();
  });

  it("hands off new work after a retained closed pane is reactivated", () => {
    const owner = {} as GatewayBrowserClient;
    const { pane, state: current } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.paneId = "p2";
    pane.discardStagedAttachments?.();
    pane.resumeStagedAttachments?.();
    pane.connectedClient = null;
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: owner,
      phase: "reconnecting",
      hello: null,
    });
    const reopened = storedAttachment("reopened");
    current.chatAttachments = [reopened];
    const scopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(current, current.sessionKey),
    );

    pane.disconnectedCallback();

    expect(
      pane.context.chatAttachmentHandoff.consume({
        owner,
        paneId: pane.paneId,
        scopeKey,
      })?.attachments,
    ).toEqual([reopened]);
    releaseChatAttachmentPayload(reopened.id);
  });

  it("deduplicates current and fallback payload release", () => {
    const shared = storedAttachment("shared");
    const fallback = storedAttachment("fallback", "application/pdf");
    const current = state([shared]);
    current.chatComposerFallbackByScope = {
      fallback: {
        attachments: [shared, fallback],
        message: "",
        sequence: 1,
        storageFailed: false,
      },
    };

    discardStateStagedAttachments(current);

    expect(getChatAttachmentDataUrl(shared)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(current.chatAttachments).toEqual([]);
    expect(current.chatComposerFallbackByScope.fallback?.attachments).toEqual([]);
  });

  it("keeps plain staged attachments across a gateway client rotation", () => {
    const previousOwner = {} as GatewayBrowserClient;
    const nextOwner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const plainImage = storedAttachment("rotation-image");
    const plainFile = storedAttachment("rotation-file", "application/pdf");
    const annotated: ChatAttachment = {
      ...storedAttachment("rotation-annotation"),
      browserAnnotation: { pageUrl: "https://example.test" } as never,
    };
    const current = state([plainImage, plainFile, annotated]);

    const returned = replacePaneStagedAttachmentGatewayOwner(
      context,
      "p1",
      current,
      previousOwner,
      nextOwner,
    );

    expect(returned).toBe(nextOwner);
    // Plain payloads are client-local; rotation must not silently discard them.
    expect(current.chatAttachments).toEqual([plainImage, plainFile]);
    expect(getChatAttachmentDataUrl(plainImage)).not.toBeNull();
    expect(getChatAttachmentDataUrl(plainFile)).not.toBeNull();
    // Annotation Undo context dies with the old client; its payload is released.
    expect(getChatAttachmentDataUrl(annotated)).toBeNull();
    discardStateStagedAttachments(current);
  });

  it("restores a mixed package only to the exact mounted owner", () => {
    const owner = {} as GatewayBrowserClient;
    const otherOwner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const image = storedAttachment("image");
    const file = storedAttachment("file", "application/pdf");
    const pastedText = storedAttachment("pasted-text", "text/plain");
    const mixed = [image, file, pastedText];

    preparePaneStagedAttachments(context, "p1", state(mixed), owner);
    const mismatched = state([]);
    restorePaneStagedAttachments(context, "p1", mismatched, otherOwner);
    expect(mismatched.chatAttachments).toEqual([]);
    expect(mixed.every((attachment) => getChatAttachmentDataUrl(attachment) === null)).toBe(true);

    const second = [storedAttachment("second-image"), storedAttachment("second-file")];
    preparePaneStagedAttachments(context, "p2", state(second), owner);
    const remount = state([]);
    restorePaneStagedAttachments(context, "p2", remount, owner);
    expect(remount.chatAttachments).toEqual(second);
    expect(remount.chatAttachments.every((attachment, index) => attachment === second[index])).toBe(
      true,
    );
    discardStateStagedAttachments(remount);
  });

  it("releases a restored fallback displaced by mounted state", () => {
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const displaced = storedAttachment("displaced");
    const mounted = storedAttachment("mounted");
    const remount = state([]);
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: storedChatOutboxScopeKey(resolveStoredChatOutboxScope(remount, remount.sessionKey)),
      attachments: [],
      fallbacks: {
        collision: {
          attachments: [displaced],
          message: "old",
          sequence: 1,
          storageFailed: false,
        },
      },
    });
    remount.chatComposerFallbackByScope = {
      collision: {
        attachments: [mounted],
        message: "new",
        sequence: 2,
        storageFailed: false,
      },
    };

    restorePaneStagedAttachments(context, "p1", remount, owner);

    expect(remount.chatComposerFallbackByScope.collision?.attachments).toEqual([mounted]);
    expect(getChatAttachmentDataUrl(displaced)).toBeNull();
    expect(getChatAttachmentDataUrl(mounted)).not.toBeNull();
    discardStateStagedAttachments(remount);
  });
});
