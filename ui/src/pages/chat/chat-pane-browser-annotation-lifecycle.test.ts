/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-browser-annotation-lifecycle.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BrowserAnnotationDraft } from "../../components/browser/browser-annotation.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  cloneChatAttachmentsForIndependentOwner,
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import {
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { resolveStoredChatOutboxScope, storedChatOutboxScopeKey } from "./composer-persistence.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("staged attachment composer adoption", () => {
  function annotationEvent() {
    return new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail: {
        modelContext: "Generated page context",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        fileName: "annotated-page.png",
        card: {
          title: "Example Domain",
          displayUrl: "example.com",
          markedRegionCount: 2,
          inspectedElement: true,
        },
      },
      cancelable: true,
    });
  }

  function storedAttachment(id: string, browserAnnotation: boolean) {
    return registerChatAttachmentPayload({
      attachment: {
        id,
        mimeType: "image/png",
        ...(browserAnnotation
          ? {
              browserAnnotation: {
                modelContext: "Context",
                title: "Page",
                displayUrl: "example.com",
                markedRegionCount: 1,
                inspectedElement: false,
              },
            }
          : {}),
      },
      dataUrl: `data:image/png;base64,${id}`,
      file: new File([id], `${id}.png`, { type: "image/png" }),
    });
  }

  it("clones payload ownership for another retained composer", () => {
    const source = storedAttachment("independent-source", false);
    const [destination] = cloneChatAttachmentsForIndependentOwner([source]);

    expect(destination?.id).not.toBe(source.id);
    expect(getChatAttachmentDataUrl(destination!)).toBe(getChatAttachmentDataUrl(source));
    releaseChatAttachmentPayload(source.id);
    expect(getChatAttachmentDataUrl(source)).toBeNull();
    expect(getChatAttachmentDataUrl(destination!)).not.toBeNull();
  });

  function connectPaneThroughAttachmentRestore(
    context: ApplicationContext,
    paneId: string,
    sessionKey: string,
  ): TestChatPane {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
    pane.context = context;
    pane.paneId = paneId;
    pane.sessionKey = sessionKey;
    const stopAfterRestore = new Error("stop after attachment restore");
    vi.spyOn(
      pane.chatState as unknown as { startComposerPersistence: () => void },
      "startComposerPersistence",
    ).mockImplementation(() => {
      throw stopAfterRestore;
    });
    expect(() => pane.connectedCallback()).toThrow(stopAfterRestore);
    return pane;
  }

  it("transfers the mounted package and releases fallback-only payloads on disconnect", () => {
    const owner = {} as GatewayBrowserClient;
    const context = createSessionContext(owner, {} as SessionCapability);
    const pane = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:current");
    const state = pane.state;
    const shared = storedAttachment("shared-annotation", true);
    const fallback = storedAttachment("fallback-annotation", true);
    const ordinary = storedAttachment("ordinary", false);
    state.chatAttachments = [shared, ordinary];
    state.chatComposerFallbackByScope = {
      fallback: {
        attachments: [shared, fallback, ordinary],
        message: "",
        sequence: 1,
        storageFailed: false,
      },
    };
    const scopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(state, state.sessionKey),
    );

    pane.disconnectedCallback();

    expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).not.toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
    const transferred = pane.context.chatAttachmentHandoff.consume({
      owner,
      paneId: pane.paneId,
      scopeKey,
    });
    expect(transferred?.attachments).toEqual([shared, ordinary]);
    expect(transferred?.attachments[0]).toBe(shared);
    expect(transferred?.attachments[1]).toBe(ordinary);
    expect(transferred?.fallbacks.fallback).toMatchObject({
      message: "",
      sequence: 1,
      storageFailed: false,
    });
    expect(transferred?.fallbacks.fallback?.attachments).toEqual([shared, fallback, ordinary]);
    releaseChatAttachmentPayload(shared.id);
    releaseChatAttachmentPayload(fallback.id);
    releaseChatAttachmentPayload(ordinary.id);
  });

  it("releases a real pane's late disconnect after application disposal", () => {
    const owner = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    const annotation = state.chatAttachments[0]!;
    const ordinary = storedAttachment("late-dispose-ordinary", false);
    state.chatAttachments.push(ordinary);
    const scopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(state, state.sessionKey),
    );
    pane.context.chatAttachmentHandoff.dispose();

    pane.disconnectedCallback();

    expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).toBeNull();
    expect(
      pane.context.chatAttachmentHandoff.consume({
        owner,
        paneId: pane.paneId,
        scopeKey,
      }),
    ).toBeNull();
  });

  it("restores an ordinary mixed package through a real pane remount", () => {
    const owner = {} as GatewayBrowserClient;
    const context = createSessionContext(owner, {} as SessionCapability);
    const pane = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:mixed-package");
    const image = storedAttachment("remount-image", false);
    const file = storedAttachment("remount-file", false);
    file.mimeType = "application/pdf";
    const pastedText = storedAttachment("remount-pasted-text", false);
    pastedText.mimeType = "text/plain";
    const staged = [image, file, pastedText];
    pane.state.chatAttachments = staged;

    pane.disconnectedCallback();
    const remount = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:mixed-package");

    expect(remount.state.chatAttachments).toEqual(staged);
    expect(
      remount.state.chatAttachments.every((attachment, index) => attachment === staged[index]),
    ).toBe(true);
    expect(staged.every((attachment) => getChatAttachmentDataUrl(attachment) !== null)).toBe(true);
    remount.discardStagedAttachments?.();
    remount.disconnectedCallback();
  });

  it("restores each retained session package under the same logical pane", () => {
    const owner = {} as GatewayBrowserClient;
    const context = createSessionContext(owner, {} as SessionCapability);
    const first = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:first");
    const second = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:second");
    const firstAttachment = storedAttachment("retained-first", false);
    const secondAttachment = storedAttachment("retained-second", false);
    first.state.chatAttachments = [firstAttachment];
    second.state.chatAttachments = [secondAttachment];

    first.disconnectedCallback();
    second.disconnectedCallback();

    const secondRemount = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:second");
    const firstRemount = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:first");
    expect(secondRemount.state.chatAttachments).toEqual([secondAttachment]);
    expect(firstRemount.state.chatAttachments).toEqual([firstAttachment]);
    secondRemount.discardStagedAttachments?.();
    firstRemount.discardStagedAttachments?.();
    secondRemount.disconnectedCallback();
    firstRemount.disconnectedCallback();
  });

  it("keeps generated context on the attachment and leaves the user's draft unchanged", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    state.chatMessage = "Keep my question exactly.";
    state.chatAttachments = [];
    state.handleChatDraftChange = vi.fn();
    const detail: BrowserAnnotationDraft = {
      modelContext: "Generated page context",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      fileName: "annotated-page.png",
      card: {
        title: "Example Domain",
        displayUrl: "example.com",
        markedRegionCount: 2,
        inspectedElement: true,
      },
    };
    const event = new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail,
      cancelable: true,
    });

    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(event);

    expect(event.defaultPrevented).toBe(true);
    expect(state.chatMessage).toBe("Keep my question exactly.");
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatAttachments[0]?.browserAnnotation).toEqual({
      modelContext: "Generated page context",
      title: "Example Domain",
      displayUrl: "example.com",
      markedRegionCount: 2,
      inspectedElement: true,
    });
    pane.discardStagedAttachments?.();
  });

  it("lets only the active pane consume a shared annotation event", () => {
    const first = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const second = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    first.pane.active = false;
    second.pane.active = true;
    first.state.chatAttachments = [];
    second.state.chatAttachments = [];
    const event = new CustomEvent<BrowserAnnotationDraft>("openclaw:browser-annotation", {
      detail: {
        modelContext: "Context",
        dataUrl: "data:image/png;base64,aGVsbG8=",
        fileName: "annotated-page.png",
        card: {
          title: "",
          displayUrl: "example.com",
          markedRegionCount: 1,
          inspectedElement: false,
        },
      },
      cancelable: true,
    });

    const receive = (pane: TestChatPane) =>
      (
        pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
      ).receiveBrowserAnnotation(event);
    receive(first.pane);
    receive(second.pane);
    receive(first.pane);

    expect(first.state.chatAttachments).toEqual([]);
    expect(second.state.chatAttachments).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    second.pane.discardStagedAttachments?.();
  });

  it("restores through a new pane after a null mount acquires its first Gateway client", () => {
    const client = {} as GatewayBrowserClient;
    const context = createSessionContext(client, {} as SessionCapability);
    (context.gateway.snapshot as { client: GatewayBrowserClient | null }).client = null;
    const pane = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:delayed-client");
    pane.active = true;
    (context.gateway.snapshot as { client: GatewayBrowserClient | null }).client = client;

    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    const captured = pane.state.chatAttachments[0]!;
    pane.disconnectedCallback();

    const remount = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:delayed-client");
    remount.applyGatewaySnapshot(context.gateway.snapshot);
    expect(remount.state.chatAttachments[0]).toBe(captured);
    remount.discardStagedAttachments?.();
    remount.disconnectedCallback();
  });

  it("rejects a new pane after client replacement instead of relabeling staged annotations", () => {
    const owner = {} as GatewayBrowserClient;
    const replacement = {} as GatewayBrowserClient;
    const context = createSessionContext(owner, {} as SessionCapability);
    const pane = connectPaneThroughAttachmentRestore(context, "p1", "agent:main:replaced-client");
    pane.active = true;
    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    const captured = pane.state.chatAttachments[0]!;
    (context.gateway.snapshot as { client: GatewayBrowserClient | null }).client = replacement;

    pane.disconnectedCallback();
    const remount = connectPaneThroughAttachmentRestore(
      context,
      "p1",
      "agent:main:replaced-client",
    );
    expect(remount.state.chatAttachments).toEqual([]);
    expect(getChatAttachmentDataUrl(captured)).toBeNull();
    remount.disconnectedCallback();
  });

  it("preserves the package on same-client reconnect and clears it on replacement", () => {
    const owner = {} as GatewayBrowserClient;
    const replacement = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    pane.active = false;
    const current = state.chatAttachments[0]!;
    const fallback = storedAttachment("replacement-fallback", true);
    const ordinary = storedAttachment("replacement-ordinary", false);
    state.chatAttachments.push(ordinary);
    state.chatComposerFallbackByScope = {
      fallback: {
        attachments: [fallback, ordinary],
        message: "",
        sequence: 1,
        storageFailed: false,
      },
    };

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: owner,
      phase: "reconnecting",
      hello: null,
    });
    expect(state.chatAttachments).toEqual([current, ordinary]);
    expect(getChatAttachmentDataUrl(current)).not.toBeNull();

    const stopAfterAnnotationOwner = new Error("stop after annotation owner");
    const cancelHeaderRename = vi.spyOn(pane, "cancelHeaderRename").mockImplementation(() => {
      throw stopAfterAnnotationOwner;
    });
    expect(() =>
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        client: owner,
        phase: "connected",
      }),
    ).toThrow(stopAfterAnnotationOwner);
    cancelHeaderRename.mockRestore();
    expect(state.chatAttachments).toEqual([current, ordinary]);
    expect(getChatAttachmentDataUrl(current)).not.toBeNull();

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacement,
      phase: "reconnecting",
      hello: null,
    });
    // Rotation invalidates annotation-backed attachments only; plain payloads
    // are client-local and survive (live state and fallbacks alike).
    expect(state.chatAttachments).toEqual([ordinary]);
    expect(state.chatComposerFallbackByScope.fallback?.attachments).toEqual([ordinary]);
    expect(getChatAttachmentDataUrl(current)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
  });

  it("discards a staged package captured without a client when the first client arrives", () => {
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    pane.connectedClient = null;
    (pane.context.gateway.snapshot as { client: GatewayBrowserClient | null }).client = null;
    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    const annotation = state.chatAttachments[0]!;
    const ordinary = storedAttachment("no-client-ordinary", false);
    state.chatAttachments.push(ordinary);

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.chatAttachments).toEqual([ordinary]);
    expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
  });

  it("invalidates annotation Undo when the logical Gateway client is replaced", async () => {
    const owner = {} as GatewayBrowserClient;
    const replacement = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.active = true;
    (
      pane as TestChatPane & { receiveBrowserAnnotation: (candidate: Event) => void }
    ).receiveBrowserAnnotation(annotationEvent());
    const annotation = state.chatAttachments[0]!;
    const ordinary = storedAttachment("undo-ordinary", false);
    state.chatAttachments.push(ordinary);
    const toastHost = document.createElement("openclaw-toast-host") as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.append(toastHost);

    (
      pane as TestChatPane & {
        removeBrowserAnnotation: (attachment: (typeof state.chatAttachments)[number]) => void;
      }
    ).removeBrowserAnnotation(annotation);
    await toastHost.updateComplete;
    expect(state.chatAttachments).toEqual([ordinary]);
    expect(getChatAttachmentDataUrl(annotation)).not.toBeNull();

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacement,
      phase: "reconnecting",
      hello: null,
    });
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();

    expect(state.chatAttachments).toEqual([ordinary]);
    expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    expect(getChatAttachmentDataUrl(ordinary)).not.toBeNull();
    toastHost.remove();
  });
});
