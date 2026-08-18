import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../chat/attachment-payload-store.ts";
import { ChatAttachmentReadLifecycle } from "../chat/components/chat-attachments.ts";

export class NewSessionAttachmentDraft {
  attachments: ChatAttachment[] = [];
  private readonly reads: ChatAttachmentReadLifecycle;

  constructor(
    private readonly notify: () => void,
    private readonly onUserChange: () => void,
  ) {
    this.reads = new ChatAttachmentReadLifecycle(notify);
  }

  get pendingReads(): number {
    return this.reads.pendingReads;
  }

  get readSignal() {
    return this.reads.readSignal;
  }

  replace(attachments: ChatAttachment[]) {
    this.attachments = attachments;
    this.onUserChange();
    this.notify();
  }

  restore(attachments: ChatAttachment[]) {
    this.attachments = attachments;
    this.notify();
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1) {
    this.reads.updatePending(readSignal, delta);
  }

  abortReads() {
    this.reads.abortReads();
  }

  take(): ChatAttachment[] {
    this.abortReads();
    const attachments = this.attachments;
    this.attachments = [];
    this.notify();
    return attachments;
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
