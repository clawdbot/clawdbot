import { describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { ToastOptions } from "../../lib/toast.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";

const labels = {
  removed: "Removed",
  undo: "Undo",
  undoUnavailable: "Remove another annotation before undoing",
};

function annotation(id: string): ChatAttachment {
  return {
    id,
    mimeType: "image/png",
    browserAnnotation: {
      modelContext: `Context ${id}`,
      title: `Title ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    },
  };
}

function createHost(initial: ChatAttachment[]) {
  let owner = {};
  let sessionKey = "agent:main";
  let attachments = initial;
  return {
    host: {
      getOwner: () => owner,
      getSessionKey: () => sessionKey,
      getAttachments: () => attachments,
      setAttachments: (next: ChatAttachment[]) => {
        attachments = next;
      },
      requestUpdate: vi.fn(),
      focusComposer: vi.fn(),
      focusRestoredAnnotation: vi.fn(),
    },
    attachments: () => attachments,
    switchSession: (next: string) => {
      sessionKey = next;
    },
    replaceOwner: () => {
      owner = {};
    },
  };
}

describe("browser annotation removal", () => {
  it("preserves siblings and restores the complete package once at its original position", () => {
    const ordinary = { id: "ordinary", mimeType: "image/png" };
    const first = annotation("first");
    const second = annotation("second");
    const state = createHost([ordinary, first, second]);
    let toast: ToastOptions | undefined;
    const releasePayload = vi.fn();

    expect(
      removeBrowserAnnotationWithUndo(state.host, first, labels, {
        presentToast: (options) => {
          toast = options;
          return true;
        },
        releasePayload,
      }),
    ).toBe(true);
    expect(state.attachments()).toEqual([ordinary, second]);

    toast?.onDismiss?.("action");
    toast?.onAction?.();
    toast?.onAction?.();

    expect(state.attachments()).toEqual([ordinary, first, second]);
    expect(state.host.focusRestoredAnnotation).toHaveBeenCalledOnce();
    expect(releasePayload).not.toHaveBeenCalled();
  });

  it.each(["timeout", "dismiss", "replaced", "disconnected"] as const)(
    "finalizes payload ownership on %s",
    (reason) => {
      const target = annotation("target");
      const state = createHost([target]);
      let toast: ToastOptions | undefined;
      const releasePayload = vi.fn();
      removeBrowserAnnotationWithUndo(state.host, target, labels, {
        presentToast: (options) => {
          toast = options;
          return true;
        },
        releasePayload,
      });

      toast?.onDismiss?.(reason);
      toast?.onDismiss?.(reason);

      expect(releasePayload).toHaveBeenCalledOnce();
      expect(state.attachments()).toEqual([]);
    },
  );

  it("never restores into a replacement session", () => {
    const target = annotation("target");
    const state = createHost([target]);
    let toast: ToastOptions | undefined;
    const releasePayload = vi.fn();
    removeBrowserAnnotationWithUndo(state.host, target, labels, {
      presentToast: (options) => {
        toast = options;
        return true;
      },
      releasePayload,
    });
    state.switchSession("agent:other");

    toast?.onDismiss?.("action");
    toast?.onAction?.();

    expect(state.attachments()).toEqual([]);
    expect(releasePayload).toHaveBeenCalledOnce();
    expect(state.host.focusRestoredAnnotation).not.toHaveBeenCalled();
  });

  it("never restores into a replacement composer owner", () => {
    const target = annotation("target");
    const state = createHost([target]);
    let toast: ToastOptions | undefined;
    const releasePayload = vi.fn();
    removeBrowserAnnotationWithUndo(state.host, target, labels, {
      presentToast: (options) => {
        toast = options;
        return true;
      },
      releasePayload,
    });
    state.replaceOwner();

    toast?.onDismiss?.("action");
    toast?.onAction?.();

    expect(state.attachments()).toEqual([]);
    expect(releasePayload).toHaveBeenCalledOnce();
    expect(state.host.focusRestoredAnnotation).not.toHaveBeenCalled();
  });

  it("releases instead of exceeding the bound when Undo follows a replacement", () => {
    const target = annotation("target");
    const state = createHost([
      target,
      annotation("second"),
      annotation("third"),
      annotation("fourth"),
    ]);
    const toasts: ToastOptions[] = [];
    const releasePayload = vi.fn();
    removeBrowserAnnotationWithUndo(state.host, target, labels, {
      presentToast: (options) => {
        toasts.push(options);
        return true;
      },
      releasePayload,
    });
    state.host.setAttachments([...state.attachments(), annotation("replacement")]);

    toasts[0]?.onDismiss?.("action");
    toasts[0]?.onAction?.();

    expect(state.attachments()).toHaveLength(4);
    expect(state.attachments()).not.toContain(target);
    expect(releasePayload).toHaveBeenCalledOnce();
    expect(toasts[1]?.message).toBe(labels.undoUnavailable);
  });

  it("releases immediately when no toast host can present Undo", () => {
    const target = annotation("target");
    const state = createHost([target]);
    const releasePayload = vi.fn();

    removeBrowserAnnotationWithUndo(state.host, target, labels, {
      presentToast: () => false,
      releasePayload,
    });

    expect(releasePayload).toHaveBeenCalledOnce();
  });
});
