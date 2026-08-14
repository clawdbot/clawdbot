// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";

vi.mock("../../../lib/toast.ts", () => ({ showToast: vi.fn() }));

import { showToast } from "../../../lib/toast.ts";

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
  const realFileReader = globalThis.FileReader;

  beforeEach(() => {
    vi.stubGlobal("FileReader", StubFileReader as unknown as typeof FileReader);
    StubFileReader.failNames = new Set();
  });

  afterEach(() => {
    vi.stubGlobal("FileReader", realFileReader);
    vi.clearAllMocks();
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
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    const message = vi.mocked(showToast).mock.calls[0]?.[0]?.message;
    // The read-failure toast is a plain t() string, not a template.
    expect(typeof message).toBe("string");
    expect(message).toContain("bad.png");
    // The successful sibling still attaches.
    const attached = onAttachmentsChange.mock.calls[0]?.[0] as Array<{ fileName?: string }>;
    expect(attached).toHaveLength(1);
    expect(attached[0]?.fileName).toBe("good.png");
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
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });
});
