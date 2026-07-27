import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../chat/attachment-payload-store.ts";

export class NewSessionAttachmentDraft {
  attachments: ChatAttachment[] = [];
  pendingReads = 0;
  private readController = new AbortController();

  constructor(private readonly notify: () => void) {}

  get readSignal() {
    return this.readController.signal;
  }

  replace(attachments: ChatAttachment[]) {
    this.attachments = attachments;
    this.notify();
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1) {
    if (this.readController.signal !== readSignal) {
      return;
    }
    this.pendingReads = Math.max(0, this.pendingReads + delta);
    this.notify();
  }

  abortReads() {
    this.readController.abort();
    this.readController = new AbortController();
    this.pendingReads = 0;
    this.notify();
  }

  reset(options: { release: boolean }) {
    this.abortReads();
    if (options.release) {
      releaseChatAttachmentPayloads(this.attachments);
    }
    this.attachments = [];
    this.notify();
  }

  clearAfterSubmit(release: boolean) {
    if (release) {
      releaseChatAttachmentPayloads(this.attachments);
    }
    this.attachments = [];
    this.notify();
  }
}
