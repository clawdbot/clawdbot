// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";

class StubFileReader {
  static failNames = new Set<string>();
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
    toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

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
