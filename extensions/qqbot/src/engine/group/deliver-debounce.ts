/**
 * Deliver debounce — merge short bursts of outbound text into one message.
 *
 * Scenario: when the framework's dispatcher emits several `deliver()` calls
 * in rapid succession (e.g. a tool returns partial text, then the agent
 * streams more text a few hundred milliseconds later), naive delivery
 * would spam the group with message fragments. The debouncer buffers
 * text for a short window and flushes it as a single message.
 *
 * Design:
 *   - One debouncer instance per inbound turn. The gateway creates it
 *     lazily on the first `deliver` and disposes it in the `finally`
 *     block — per-peer bookkeeping is therefore unnecessary because the
 *     instance lifecycle already matches the peer's reply window.
 *   - Any payload carrying media (`mediaUrl` / `mediaUrls`) is NOT
 *     buffered: we flush the buffered text first, then forward the
 *     media-bearing payload immediately so media stays in-order.
 *   - Two timers: a sliding `windowMs` timer (reset on every new text)
 *     and a hard `maxWaitMs` cap (started on the first buffered text)
 *     prevent starvation when text keeps arriving faster than the window.
 *
 * The class is pure in-process logic; no I/O and no platform bindings.
 * Safe to share between the built-in and standalone plugin builds.
 */

// ============ Defaults ============

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_SEPARATOR = "\n\n---\n\n";

// ============ Types ============

/** Configuration for {@link DeliverDebouncer}. */
export interface DeliverDebounceConfig {
  /** Master switch. Default: true (enabled). Set to `false` to disable. */
  enabled?: boolean;
  /** Sliding-window duration in milliseconds. Default: 1500. */
  windowMs?: number;
  /**
   * Maximum time to hold buffered text measured from the first buffered
   * entry. Prevents starvation when text keeps arriving. Default: 8000.
   */
  maxWaitMs?: number;
  /** Separator inserted between merged text fragments. Default: `"\n\n---\n\n"`. */
  separator?: string;
}

/** Shape of a deliver payload (text + optional media URLs). */
export interface DeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/** Metadata attached by the framework's dispatcher to each deliver call. */
export interface DeliverInfo {
  kind: string;
}

/** The actual send function that the debouncer eventually invokes. */
export type DeliverExecutor = (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;

/** Minimal logger interface (matches `EngineLogger`). */
export interface DebouncerLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

// ============ Implementation ============

/**
 * Debouncer for a single outbound turn.
 *
 * Usage:
 * ```ts
 * const debouncer = createDeliverDebouncer(cfg, executeDeliver, log, prefix);
 * try {
 *   await debouncer.deliver(payload, info); // called per deliver event
 * } finally {
 *   await debouncer.dispose();              // flush any leftover buffer
 * }
 * ```
 */
export class DeliverDebouncer {
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly separator: string;
  private readonly executor: DeliverExecutor;
  private readonly log?: DebouncerLogger;
  private readonly prefix: string;

  /** Buffered text fragments waiting to be merged. */
  private bufferedTexts: string[] = [];
  /** Info from the most recent buffered call — used when we flush. */
  private lastInfo: DeliverInfo | null = null;
  /** Non-text fields from the most recent buffered call — preserved on flush. */
  private lastPayload: DeliverPayload | null = null;
  /** Sliding window timer (reset on each new buffered call). */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hard upper bound timer (armed once per burst). */
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against re-entrant flushes. */
  private flushing = false;
  /** Lifecycle flag — once disposed, further deliver calls are ignored. */
  private disposed = false;

  constructor(
    config: DeliverDebounceConfig | undefined,
    executor: DeliverExecutor,
    log?: DebouncerLogger,
    prefix = "[debounce]",
  ) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.separator = config?.separator ?? DEFAULT_SEPARATOR;
    this.executor = executor;
    this.log = log;
    this.prefix = prefix;
  }

  /**
   * Accept one deliver call.
   *
   * - Payloads with media → flush buffered text first, then execute.
   * - Empty-text payloads → pass through directly (no buffering).
   * - Non-empty text payloads → buffer and (re-)arm the timers.
   */
  async deliver(payload: DeliverPayload, info: DeliverInfo): Promise<void> {
    if (this.disposed) {
      return;
    }

    const hasMedia = Boolean(
      (payload.mediaUrls && payload.mediaUrls.length > 0) || payload.mediaUrl,
    );

    if (hasMedia) {
      this.log?.info(
        `${this.prefix} Media deliver detected, flushing ${this.bufferedTexts.length} buffered text(s) first`,
      );
      await this.flush();
      await this.executor(payload, info);
      return;
    }

    const text = (payload.text ?? "").trim();
    if (!text) {
      await this.executor(payload, info);
      return;
    }

    // Buffer the text and track the latest payload/info so `flush()` can
    // forward non-text fields to the executor.
    this.bufferedTexts.push(text);
    this.lastInfo = info;
    this.lastPayload = payload;

    this.log?.info(
      `${this.prefix} Buffered text #${this.bufferedTexts.length} (${text.length} chars), window=${this.windowMs}ms`,
    );

    // Reset the sliding-window timer so bursty input keeps extending the wait.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush().catch((err) => {
        this.log?.error(`${this.prefix} Flush error (debounce timer): ${String(err)}`);
      });
    }, this.windowMs);

    // Arm the hard-cap timer only on the first buffered text of a burst.
    if (this.bufferedTexts.length === 1) {
      if (this.maxWaitTimer) {
        clearTimeout(this.maxWaitTimer);
      }
      this.maxWaitTimer = setTimeout(() => {
        this.log?.info(`${this.prefix} Max wait (${this.maxWaitMs}ms) reached, force flushing`);
        this.flush().catch((err) => {
          this.log?.error(`${this.prefix} Flush error (max wait timer): ${String(err)}`);
        });
      }, this.maxWaitMs);
    }
  }

  /** Merge buffered text into a single executor call. */
  async flush(): Promise<void> {
    if (this.flushing || this.bufferedTexts.length === 0) {
      return;
    }
    this.flushing = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    // Snapshot and reset state BEFORE awaiting so that a concurrent
    // `deliver()` (arriving while we're awaiting the executor) sees an
    // empty buffer and starts a fresh burst.
    const texts = this.bufferedTexts;
    const info = this.lastInfo!;
    const lastPayload = this.lastPayload!;
    this.bufferedTexts = [];
    this.lastInfo = null;
    this.lastPayload = null;

    try {
      if (texts.length === 1) {
        this.log?.info(`${this.prefix} Flushing single buffered text (${texts[0].length} chars)`);
        await this.executor({ ...lastPayload, text: texts[0] }, info);
      } else {
        const merged = texts.join(this.separator);
        this.log?.info(
          `${this.prefix} Merged ${texts.length} buffered texts into one (${merged.length} chars)`,
        );
        await this.executor({ ...lastPayload, text: merged }, info);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Flush any pending buffer and mark the debouncer as disposed.
   * Subsequent `deliver()` calls become no-ops.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
    if (this.bufferedTexts.length > 0) {
      // Allow `flush` to run even after `disposed` is set: the state
      // reset inside flush makes this safe.
      this.flushing = false;
      await this.flush();
    }
  }

  /** Whether any text is currently buffered. */
  get hasPending(): boolean {
    return this.bufferedTexts.length > 0;
  }

  /** Number of buffered fragments. */
  get pendingCount(): number {
    return this.bufferedTexts.length;
  }
}

// ============ Factory ============

/**
 * Create a debouncer instance or `null` when debouncing is disabled.
 *
 * Convention: when `config.enabled === false` the caller should call the
 * executor directly without buffering. Returning `null` (rather than a
 * pass-through debouncer) makes the disabled path visible at the call
 * site.
 */
export function createDeliverDebouncer(
  config: DeliverDebounceConfig | undefined,
  executor: DeliverExecutor,
  log?: DebouncerLogger,
  prefix?: string,
): DeliverDebouncer | null {
  if (config?.enabled === false) {
    return null;
  }
  return new DeliverDebouncer(config, executor, log, prefix);
}
