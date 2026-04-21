/**
 * Message deliver debounce — merge multiple rapid deliver calls into one.
 *
 * When QQ Bot sends multiple messages in quick succession (e.g. streaming
 * partial responses), this module buffers them within a configurable time
 * window and merges them into a single outbound message.
 *
 * This prevents "message bombing" in group chats where rapid-fire messages
 * flood the chat and annoy users.
 *
 * The module is a pure function / class with zero I/O dependencies.
 */

/** Configuration for the deliver debouncer. */
export interface DeliverDebounceConfig {
  /** Whether debouncing is enabled. Defaults to true. */
  enabled: boolean;
  /** Time window in milliseconds. Defaults to 1500ms. */
  windowMs?: number;
}

/** Payload passed to deliver callbacks. */
export interface DeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/** Deliver callback info. */
export interface DeliverInfo {
  kind: string;
}

/** The actual deliver function signature. */
export type DeliverFn = (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;

interface PendingEntry {
  texts: string[];
  mediaUrls: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

/**
 * Debouncer that merges rapid-fire deliver calls within a time window.
 *
 * Usage:
 * ```ts
 * const debouncer = new DeliverDebouncer({ enabled: true, windowMs: 1500 });
 *
 * // In the deliver callback:
 * await debouncer.deliver(payload, info, originalDeliverFn);
 * ```
 */
export class DeliverDebouncer {
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(config?: DeliverDebounceConfig) {
    this.enabled = config?.enabled !== false;
    this.windowMs = config?.windowMs ?? 1500;
  }

  /**
   * Buffer a deliver call and flush after the window expires.
   *
   * @param payload - The deliver payload.
   * @param info - Deliver metadata (kind, etc.).
   * @param actualDeliver - The real deliver function to call with merged content.
   * @param peerId - Peer identifier for per-conversation debouncing.
   */
  async deliver(
    payload: DeliverPayload,
    info: DeliverInfo,
    actualDeliver: DeliverFn,
    peerId = "default",
  ): Promise<void> {
    // Pass through immediately when debouncing is disabled.
    if (!this.enabled) {
      return actualDeliver(payload, info);
    }

    // Media payloads flush any buffered text first, then send immediately.
    const hasMedia = (payload.mediaUrls && payload.mediaUrls.length > 0) || !!payload.mediaUrl;

    if (hasMedia) {
      await this.flush(peerId, actualDeliver, info);
      return actualDeliver(payload, info);
    }

    const text = (payload.text ?? "").trim();
    if (!text) {
      return;
    }

    const existing = this.pending.get(peerId);
    if (existing) {
      // Extend the buffer with the new text.
      existing.texts.push(text);
      // Reset the timer.
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.flush(peerId, actualDeliver, info).catch(() => {});
      }, this.windowMs);
      // The caller awaits the same promise as the first buffered call.
      return new Promise<void>((resolve) => {
        const origResolve = existing.resolve;
        existing.resolve = () => {
          origResolve();
          resolve();
        };
      });
    }

    // First message in a new window — start buffering.
    return new Promise<void>((resolve) => {
      const entry: PendingEntry = {
        texts: [text],
        mediaUrls: [],
        timer: setTimeout(() => {
          this.flush(peerId, actualDeliver, info).catch(() => {});
        }, this.windowMs),
        resolve,
      };
      this.pending.set(peerId, entry);
    });
  }

  /** Flush buffered content for a peer and invoke the actual deliver. */
  private async flush(peerId: string, actualDeliver: DeliverFn, info: DeliverInfo): Promise<void> {
    const entry = this.pending.get(peerId);
    if (!entry) {
      return;
    }

    this.pending.delete(peerId);
    clearTimeout(entry.timer);

    const mergedText = entry.texts.join("\n").trim();
    if (mergedText) {
      await actualDeliver({ text: mergedText }, info);
    }

    entry.resolve();
  }

  /** Force-flush all pending entries (e.g. during shutdown). */
  async flushAll(actualDeliver: DeliverFn, info: DeliverInfo): Promise<void> {
    const peerIds = [...this.pending.keys()];
    for (const peerId of peerIds) {
      await this.flush(peerId, actualDeliver, info);
    }
  }
}
