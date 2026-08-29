// Render contract between the transcript projection and the per-session
// virtualizer host owned by ChatTranscriptController.
import type { TemplateResult } from "lit";
import type { TranscriptAnnouncement } from "./chat-transcript-announcement.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

export type TranscriptCallbacks = {
  onViewportResize?: () => void;
  onReaderScroll?: () => void;
};

export const CHAT_TRANSCRIPT_ESTIMATED_ROW_PX = 120;
export const CHAT_TRANSCRIPT_OVERSCAN = 6;
// Initial virtual rows can correct their estimates for several frames. Hold a
// restored offset for ~200ms so those corrections cannot reapply the end anchor.
export const CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES = 12;
// A committed short transcript can legitimately remain at maxOffset=0. Give
// initial measurement one second before treating that zero range as final.
export const CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES = 60;

export type TranscriptHeader = {
  template: unknown;
  /** Fixed pixel height; becomes the virtualizer's scrollMargin so row offsets stay exact. */
  height: number;
};

export type ChatTranscriptSession = {
  readonly liveAnnouncementText: string;
  readonly scrollElementRef: (element?: Element) => void;
  render<T>(
    rows: readonly TranscriptRow<T>[],
    renderRow: (row: TranscriptRow<T>) => unknown,
    announcement: TranscriptAnnouncement | null,
    announce: boolean,
    overlay?: unknown,
    header?: TranscriptHeader | null,
  ): TemplateResult;
  syncMessageRows(messageRowKeysById: ReadonlyMap<string, string>): void;
  revealMessage(messageId: string): boolean;
  setContentReady(ready: boolean): void;
  handleFocusIn(event: FocusEvent): void;
  handleFocusOut(event: FocusEvent): void;
};
