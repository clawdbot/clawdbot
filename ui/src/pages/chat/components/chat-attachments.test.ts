// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as payloads from "../attachment-payload-store.ts";
import {
  chatAttachmentFromDataUrl,
  ChatAttachmentReadLifecycle,
  handleChatAttachmentPaste,
} from "./chat-attachments.ts";

it("admits same-name image payloads with independent identities", () => {
  const sources = ["data:image/png;base64,YmVmb3Jl", "data:image/png;base64,YWZ0ZXIh"];
  const attachments = sources.map((source) => {
    const attachment = expectDefined(
      chatAttachmentFromDataUrl(source, "capture.png"),
      "admitted image attachment",
    );
    onTestFinished(() => payloads.releaseChatAttachmentPayload(attachment.id));
    return attachment;
  });

  expect(attachments[0]?.id).not.toBe(attachments[1]?.id);
  expect(attachments.map(({ fileName, sizeBytes }) => ({ fileName, sizeBytes }))).toEqual([
    { fileName: "capture.png", sizeBytes: 6 },
    { fileName: "capture.png", sizeBytes: 6 },
  ]);
  expect(attachments.map(payloads.getChatAttachmentDataUrl)).toEqual(sources);
});

class StubFileReader {
  static failNames = new Set<string>();
  static heldNames = new Set<string>();
  result: string | ArrayBuffer | null = null;
  private listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener() {}
  abort() {}

  readAsDataURL(file: File) {
    if (StubFileReader.heldNames.has(file.name)) {
      return;
    }
    queueMicrotask(() => {
      if (StubFileReader.failNames.has(file.name)) {
        this.emit("error");
        return;
      }
      this.result = "data:image/png;base64,aGk=";
      this.emit("load");
    });
  }

  private emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function pasteEventWithFiles(files: File[]): ClipboardEvent {
  return {
    preventDefault: () => {},
    clipboardData: {
      items: files.map((file) => ({
        type: file.type,
        getAsFile: () => file,
      })),
      getData: () => "",
    },
  } as unknown as ClipboardEvent;
}

describe("chat attachment read failures", () => {
  let toastHost: HTMLElementTagNameMap["openclaw-toast-host"];

  beforeEach(() => {
    vi.stubGlobal("FileReader", StubFileReader as unknown as typeof FileReader);
    StubFileReader.failNames = new Set();
    StubFileReader.heldNames = new Set();
    toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "releases a completed payload when its pasted batch aborts (presented=%s)",
    async (presented) => {
      StubFileReader.heldNames.add("held.png");
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const create = vi.fn(() => "blob:completed-paste");
      const revoke = vi.fn();
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = create;
          static override revokeObjectURL = revoke;
        },
      );
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      const onAttachmentsChange = vi.fn();
      handleChatAttachmentPaste(
        pasteEventWithFiles([
          new File(["hi"], "completed.png", { type: "image/png" }),
          new File(["held"], "held.png", { type: "image/png" }),
        ]),
        {
          attachments: [],
          readSignal: signal,
          onAttachmentsChange,
          onPendingReadsChange: (delta) => reads.updatePending(signal, delta),
        },
      );
      await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
      const attachment = expectDefined(
        registered.mock.calls[0]?.[0].attachment,
        "completed payload",
      );
      onTestFinished(() => payloads.releaseChatAttachmentPayload(attachment.id));
      expect(payloads.getChatAttachmentDataUrl(attachment)).toBe("data:image/png;base64,aGk=");
      expect(create).not.toHaveBeenCalled();
      expect(reads.pendingReads).toBe(1);
      if (presented) {
        expect(payloads.getChatAttachmentPreviewUrl(attachment)).toBe("blob:completed-paste");
      }

      reads.abortReads();

      await vi.waitFor(() => expect(payloads.getChatAttachmentDataUrl(attachment)).toBeNull());
      expect(payloads.getChatAttachmentBlob(attachment)).toBeNull();
      expect(reads.pendingReads).toBe(0);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(presented ? 1 : 0);
      expect(revoke.mock.calls).toEqual(presented ? [["blob:completed-paste"]] : []);
    },
  );

  it("names files whose read failed instead of dropping them silently", async () => {
    StubFileReader.failNames = new Set(["bad.png"]);
    const onAttachmentsChange = vi.fn();
    handleChatAttachmentPaste(
      pasteEventWithFiles([
        new File(["ok"], "good.png", { type: "image/png" }),
        new File(["broken"], "bad.png", { type: "image/png" }),
      ]),
      { attachments: [], onAttachmentsChange },
    );
    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalled();
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("bad.png");
    // The successful sibling still attaches.
    const attached = onAttachmentsChange.mock.calls[0]?.[0] as Array<{ fileName?: string }>;
    expect(attached).toHaveLength(1);
    expect(attached[0]?.fileName).toBe("good.png");
  });

  it("rejects oversized files against hello policy before encoding", async () => {
    const onAttachmentsChange = vi.fn();
    const limits = { maxBytes: 8, maxImageBytes: 4 };
    handleChatAttachmentPaste(
      pasteEventWithFiles([
        new File(["tiny"], "small.png", { type: "image/png" }),
        new File(["way-too-big"], "huge.png", { type: "image/png" }),
      ]),
      { attachmentLimits: limits, attachments: [], onAttachmentsChange },
    );
    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalled();
    });
    await toastHost.updateComplete;
    // Oversized file is named in a toast and never encoded; the small one attaches.
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("huge.png");
    const attached = onAttachmentsChange.mock.calls[0]?.[0] as Array<{ fileName?: string }>;
    expect(attached).toHaveLength(1);
    expect(attached[0]?.fileName).toBe("small.png");
  });

  it("blocks an image-only batch that exceeds the image ceiling entirely", async () => {
    const onAttachmentsChange = vi.fn();
    handleChatAttachmentPaste(
      pasteEventWithFiles([new File(["way-too-big"], "huge.png", { type: "image/png" })]),
      {
        attachmentLimits: { maxBytes: 1024, maxImageBytes: 4 },
        attachments: [],
        onAttachmentsChange,
      },
    );
    await toastHost.updateComplete;
    await vi.waitFor(() => {
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("huge.png");
    });
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("rejects a zero-byte file instead of silently dropping it after send", async () => {
    const onAttachmentsChange = vi.fn();
    handleChatAttachmentPaste(
      pasteEventWithFiles([new File([], "empty.png", { type: "image/png" })]),
      { attachments: [], onAttachmentsChange },
    );
    await toastHost.updateComplete;
    await vi.waitFor(() => {
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("empty.png");
    });
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("blocks a large text paste that exceeds the non-image ceiling", async () => {
    const onAttachmentsChange = vi.fn();
    const text = "x".repeat(2048);
    handleChatAttachmentPaste(
      {
        preventDefault: () => {},
        clipboardData: {
          items: [],
          getData: (type: string) => (type === "text/plain" ? text : ""),
        },
      } as unknown as ClipboardEvent,
      {
        attachmentLimits: { maxBytes: 1024, maxImageBytes: 1024 },
        attachments: [],
        onAttachmentsChange,
      },
    );
    await toastHost.updateComplete;
    await vi.waitFor(() => {
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("pasted-text");
    });
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("blocks a pasted data-URL image that exceeds the image ceiling", async () => {
    const onAttachmentsChange = vi.fn();
    const bigBase64 = btoa("p".repeat(64));
    handleChatAttachmentPaste(
      {
        preventDefault: () => {},
        clipboardData: {
          items: [],
          getData: (type: string) =>
            type === "text/plain" ? `data:image/png;base64,${bigBase64}` : "",
        },
      } as unknown as ClipboardEvent,
      {
        attachmentLimits: { maxBytes: 1024, maxImageBytes: 16 },
        attachments: [],
        onAttachmentsChange,
      },
    );
    await toastHost.updateComplete;
    await vi.waitFor(() => {
      expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain("pasted-image");
    });
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("does not toast when every read succeeds", async () => {
    const onAttachmentsChange = vi.fn();
    handleChatAttachmentPaste(
      pasteEventWithFiles([new File(["ok"], "good.png", { type: "image/png" })]),
      { attachments: [], onAttachmentsChange },
    );
    await vi.waitFor(() => {
      expect(onAttachmentsChange).toHaveBeenCalled();
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();
  });
});
