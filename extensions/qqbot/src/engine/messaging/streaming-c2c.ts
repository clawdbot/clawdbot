/**
 * QQ Bot Streaming Message Controller
 *
 * Core principles:
 * 1. Never mutate original content (no trim, no strip) to avoid PREFIX MISMATCH.
 * 2. Media tags are sent synchronously — wait for completion before proceeding.
 * 3. When a rich-media tag (including an unclosed prefix) is encountered,
 *    terminate the active streaming session first, then handle the media.
 * 4. Whitespace-only chunk handling:
 *    - First chunk is whitespace → defer sending (do not open a stream), but retain content.
 *    - Interrupted by a media tag or ended while still whitespace-only → skip sending.
 *    - Ended with an active streaming session (prior non-whitespace chunks exist) → send the whitespace chunk.
 * 5. Reply boundary detection uses prefix matching (not just length reduction):
 *    if the new text is not a prefix continuation of the last processed text,
 *    it is treated as a new message.
 */

import { getNextMsgSeq } from "../api/routes.js";
import type { GatewayAccount } from "../types.js";
import {
  StreamInputMode,
  StreamInputState,
  StreamContentType,
  type MessageResponse,
} from "../types.js";
import { normalizeMediaTags } from "../utils/media-tags.js";
import type { MediaTargetContext } from "./outbound.js";
import { getMessageApi } from "./sender.js";
import {
  stripIncompleteMediaTag,
  findFirstClosedMediaTag,
  executeSendQueue,
  type SendQueueItem,
  type MediaSendContext,
} from "./streaming-media-send.js";

function formatStreamErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ============ 常量 ============

/** 流式消息节流常量（毫秒） */
const THROTTLE_CONSTANTS = {
  /** 默认节流间隔 */
  DEFAULT_MS: 500,
  /** 最小节流间隔 */
  MIN_MS: 300,
  /** 长间隔阈值：超过此时间后的首次 flush 延迟处理 */
  LONG_GAP_THRESHOLD_MS: 2000,
  /** 长间隔后的批处理窗口 */
  BATCH_AFTER_GAP_MS: 300,
} as const;

/** 流式状态机阶段 */
type StreamingPhase = "idle" | "streaming" | "completed" | "aborted";

/** 终态集合 */
const TERMINAL_PHASES = new Set<StreamingPhase>(["completed", "aborted"]);

/** 允许的状态转换 */
const PHASE_TRANSITIONS: Record<StreamingPhase, Set<StreamingPhase>> = {
  idle: new Set(["streaming", "aborted"]),
  streaming: new Set(["idle", "completed", "aborted"]), // idle: 首分片发送失败时可回退
  completed: new Set(),
  aborted: new Set(),
};

// ============ FlushController ============

/**
 * 节流刷新控制器（纯调度原语，不含业务逻辑）
 */
class FlushController {
  private doFlush: () => Promise<void>;
  private flushInProgress = false;
  private flushResolvers: Array<() => void> = [];
  private needsReflush = false;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTime = 0;
  private isCompleted = false;
  private _ready = false;

  constructor(doFlush: () => Promise<void>) {
    this.doFlush = doFlush;
  }

  /** 标记为已完成 —— 当前 flush 之后不再调度新 flush */
  complete(): void {
    this.isCompleted = true;
  }

  /** 取消待执行的延迟 flush */
  cancelPendingFlush(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  /** 等待当前进行中的 flush 完成 */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve));
  }

  /** 取消所有 pending timer + 等待正在执行的 flush 完成，确保 flush 活动彻底停止 */
  async cancelPendingAndWait(): Promise<void> {
    this.cancelPendingFlush();
    this.needsReflush = false;
    await this.waitForFlush();
    // flush 完成后可能又触发了 reflush timer，再次清理
    this.cancelPendingFlush();
    this.needsReflush = false;
  }

  /** 标记流式会话就绪（首次 API 调用成功后） */
  setReady(ready: boolean): void {
    this._ready = ready;
    if (ready) {
      this.lastUpdateTime = Date.now();
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  /** 重置为初始状态（用于流式会话恢复） */
  reset(doFlush: () => Promise<void>): void {
    this.cancelPendingFlush();
    this.doFlush = doFlush;
    this.flushInProgress = false;
    this.flushResolvers = [];
    this.needsReflush = false;
    this.lastUpdateTime = 0;
    this.isCompleted = false;
    this._ready = false;
  }

  /** 执行一次 flush（互斥锁 + 冲突时 reflush） */
  async flush(): Promise<void> {
    if (!this._ready || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) {
        this.needsReflush = true;
      }
      return;
    }

    this.flushInProgress = true;
    this.needsReflush = false;
    this.lastUpdateTime = Date.now();

    try {
      await this.doFlush();
      this.lastUpdateTime = Date.now();
    } finally {
      this.flushInProgress = false;
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }

      // flush 期间有新事件到达 → 立即跟进
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, 0);
      }
    }
  }

  /** 节流入口：根据 throttleMs 控制 flush 频率 */
  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this._ready) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;

    if (elapsed >= throttleMs) {
      this.cancelPendingFlush();
      if (elapsed > THROTTLE_CONSTANTS.LONG_GAP_THRESHOLD_MS) {
        // 长间隔后首次 flush 延迟，等待更多文本积累
        this.lastUpdateTime = now;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, THROTTLE_CONSTANTS.BATCH_AFTER_GAP_MS);
      } else {
        await this.flush();
      }
    } else if (!this.pendingFlushTimer) {
      // 在节流窗口内 → 延迟 flush
      const delay = throttleMs - elapsed;
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        void this.flush();
      }, delay);
    }
  }
}

// ============ StreamingController ============

/** StreamingController 的依赖注入 */
export interface StreamingControllerDeps {
  /** QQ Bot 账户配置 */
  account: GatewayAccount;
  /** 目标用户 openid（流式 API 仅支持 C2C） */
  userId: string;
  /** 被动回复的消息 ID */
  replyToMsgId: string;
  /** 事件 ID */
  eventId: string;
  /** 日志前缀 */
  logPrefix?: string;
  /** 日志对象（直接传 gateway 的 log） */
  log?: {
    info(msg: string): void;
    error(msg: string): void;
    warn?(msg: string): void;
    debug?(msg: string): void;
  };
  /**
   * 媒体发送上下文（用于在流式模式下发送富媒体）
   * 如果不提供，遇到媒体标签时会抛出错误导致 fallback
   */
  mediaContext?: StreamingMediaContext;
}

/**
 * QQ Bot 流式消息控制器
 *
 * 管理 C2C 流式消息的完整生命周期：
 * 1. idle: 初始状态，等待首次文本
 * 2. streaming: 流式发送中，通过 API 逐步更新消息内容
 * 3. completed: 正常完成，已发送 input_state="10"
 * 4. aborted: 中止（进程退出/错误）
 *
 * 富媒体标签处理流程：
 * 当检测到富媒体标签时：
 * 1. 将标签前的文本通过流式发完 → 结束当前流式会话 (input_state="10")
 * 2. 同步等待媒体发送完成
 * 3. 创建新的流式会话 → 继续发送标签后的剩余文本
 */
export class StreamingController {
  // ---- 状态机 ----
  private phase: StreamingPhase = "idle";

  // ---- 核心文本状态 ----
  /**
   * 最后一次收到的完整 normalized 全量文本。
   * - onPartialReply 每次更新（回复边界时会拼接前缀）
   * - performFlush 从 sentIndex 开始切片来获取当前会话的显示内容
   * - onIdle 校验时用于前缀匹配
   */
  private lastNormalizedFull = "";
  /**
   * 最后一次收到的完整原始文本（未经 normalize）。
   * 仅用于回复边界检测——原始文本在 partial reply 过程中是稳定递增的，
   * 不会因为 normalizeMediaTags 对未闭合标签的处理差异导致前缀不匹配。
   */
  private lastRawFull = "";
  /**
   * 边界拼接前缀：检测到新回复时，将之前的全部内容 + "\n\n" 存为前缀。
   * 后续回调传入的 text 都会自动加上此前缀来还原完整文本。
   * 为 null 表示当前没有发生过边界拼接。
   */
  private _boundaryPrefix: string | null = null;
  /**
   * 在 lastNormalizedFull 中已经"消费"到的位置。
   * "消费"包括：已通过流式发送并终结的文本段、已处理的媒体标签。
   * - 每次流式会话终结（endCurrentStreamIfNeeded）后推进到终结点
   * - 每次媒体标签处理后推进到标签结束位置
   * - resetStreamSession 后，新的流式会话从 sentIndex 开始
   */
  private sentIndex = 0;

  // ---- 流式会话 ----
  private streamMsgId: string | null = null;
  /** 当前流式会话的 msg_seq，同一会话内所有 chunk 共享；null 表示需要重新生成 */
  private msgSeq: number | null = null;
  private streamIndex = 0;
  private dispatchFullyComplete = false;

  // ---- 串行队列：确保 onPartialReply / onIdle 严格按序执行 ----
  /** Promise 链，回调的实际逻辑都挂到链尾，保证串行 */
  private _callbackChain: Promise<void> = Promise.resolve();

  // ---- 互斥：首个到达的回调锁定控制权 ----
  /**
   * 记录首先到达的回调来源，后续其他来源的回调将被忽略。
   * - null: 尚未确定
   * - 非 null: 已锁定，只有相同来源的回调才允许继续执行
   */
  private firstCallbackSource: string | null = null;

  /**
   * 尝试获取回调互斥锁。
   * - 尚未锁定 → 锁定为 source，返回 true
   * - 已锁定且来源相同 → 返回 true
   * - 已锁定且来源不同 → 返回 false（调用方应跳过）
   */
  private acquireCallbackLock(source: string): boolean {
    if (this.firstCallbackSource === null) {
      this.firstCallbackSource = source;
      this.logInfo(`acquireCallbackLock: locked to "${source}"`);
      return true;
    }
    if (this.firstCallbackSource === source) {
      return true;
    }
    this.logDebug(
      `acquireCallbackLock: rejected "${source}" (locked by "${this.firstCallbackSource}")`,
    );
    return false;
  }

  // ---- 降级 ----
  /** 成功发送的流式分片数或媒体数（用于 onDeliver 互斥判断 + 降级判断） */
  private sentStreamChunkCount = 0;
  /** 是否成功发送过至少一个媒体文件 */
  private sentMediaCount = 0;

  // ---- 启动锁 ----
  private startingPromise: Promise<void> | null = null;

  // ---- 子控制器 ----
  private flush: FlushController;

  // ---- 配置 ----
  private throttleMs: number;

  // ---- 注入依赖 ----
  private deps: StreamingControllerDeps;

  constructor(deps: StreamingControllerDeps) {
    this.deps = deps;
    this.flush = new FlushController(() => this.performFlush());
    this.throttleMs = THROTTLE_CONSTANTS.DEFAULT_MS;
    if (this.throttleMs < THROTTLE_CONSTANTS.MIN_MS) {
      this.throttleMs = THROTTLE_CONSTANTS.MIN_MS;
    }
  }

  // ------------------------------------------------------------------
  // 公共访问器
  // ------------------------------------------------------------------

  get isTerminalPhase(): boolean {
    return TERMINAL_PHASES.has(this.phase);
  }

  get currentPhase(): StreamingPhase {
    return this.phase;
  }

  /**
   * 是否应降级到非流式（普通消息）发送
   *
   * 条件：流式会话进入终态，且从未成功发出过任何一个流式分片或媒体
   */
  get shouldFallbackToStatic(): boolean {
    return this.isTerminalPhase && this.sentStreamChunkCount === 0;
  }

  /** debug 用：暴露发送计数给 gateway 日志 */
  get sentChunkCount_debug(): number {
    return this.sentStreamChunkCount;
  }

  // ------------------------------------------------------------------
  // 状态机
  // ------------------------------------------------------------------

  private transition(to: StreamingPhase, source: string, reason?: string): boolean {
    const from = this.phase;
    if (from === to) {
      return false;
    }
    if (!PHASE_TRANSITIONS[from].has(to)) {
      this.logWarn(`phase transition rejected: ${from} → ${to} (source: ${source})`);
      return false;
    }
    this.phase = to;
    this.logInfo(
      `phase: ${from} → ${to} (source: ${source}${reason ? `, reason: ${reason}` : ""})`,
    );
    if (TERMINAL_PHASES.has(to)) {
      this.onEnterTerminalPhase();
    }
    return true;
  }

  private onEnterTerminalPhase(): void {
    this.flush.cancelPendingFlush();
    this.flush.complete();
  }

  private get prefix(): string {
    return this.deps.logPrefix ?? "[qqbot:streaming]";
  }

  private logInfo(msg: string): void {
    const m = `${this.prefix} ${msg}`;
    const engineLog = this.deps.log;
    if (engineLog) {
      engineLog.info?.(m);
    } else {
      console.log(m);
    }
  }
  private logError(msg: string): void {
    const m = `${this.prefix} ${msg}`;
    const engineLog = this.deps.log;
    if (engineLog) {
      engineLog.error?.(m);
    } else {
      console.error(m);
    }
  }
  private logWarn(msg: string): void {
    const m = `${this.prefix} ${msg}`;
    const engineLog = this.deps.log;
    if (engineLog) {
      if (engineLog.warn) {
        engineLog.warn(m);
      } else {
        engineLog.info?.(m);
      }
    } else {
      console.warn(m);
    }
  }
  private logDebug(msg: string): void {
    const m = `${this.prefix} ${msg}`;
    const engineLog = this.deps.log;
    if (engineLog) {
      engineLog.debug?.(m);
    } else {
      console.debug(m);
    }
  }

  // ------------------------------------------------------------------
  // SDK 回调绑定
  // ------------------------------------------------------------------

  /**
   * 处理 onPartialReply 回调（流式文本全量更新）
   *
   * ★ 通过 Promise 链严格串行化：前一次处理完成后才执行下一次，
   *   避免并发交叉导致的状态不一致。
   *
   * payload.text 是从头到尾的完整当前文本（每次回调都是全量）。
   * 核心逻辑：normalize → 更新 lastNormalizedFull → 从 sentIndex 开始 processMediaTags
   */
  async onPartialReply(payload: { text?: string }): Promise<void> {
    if (this.isTerminalPhase) {
      return;
    }
    if (!payload.text) {
      return;
    }

    // ★ 互斥锁在入口检查：如果已被 deliver 锁定，直接跳过，无需排队
    if (!this.acquireCallbackLock("partial")) {
      return;
    }

    // 将实际逻辑挂到 Promise 链尾部，保证串行执行
    this._callbackChain = this._callbackChain.then(
      () => this._doPartialReply(payload),
      (err) => {
        // 上一次如果异常，不阻塞后续调用
        this.logError(`onPartialReply chain error: ${formatStreamErr(err)}`);
        return this._doPartialReply(payload);
      },
    );
    return this._callbackChain;
  }

  /** onPartialReply 的实际逻辑（由 _callbackChain 保证串行调用） */
  private async _doPartialReply(payload: { text?: string }): Promise<void> {
    this.logDebug(
      `onPartialReply: rawLen=${payload.text?.length ?? 0}, phase=${this.phase}, streamMsgId=${this.streamMsgId}, sentIndex=${this.sentIndex}, firstCB=${this.firstCallbackSource}`,
    );
    if (this.isTerminalPhase) {
      this.logDebug(`onPartialReply: skipped (terminal phase)`);
      return;
    }

    const text = payload.text ?? "";
    if (!text) {
      this.logDebug(`onPartialReply: skipped (empty text)`);
      return;
    }

    // ★ 如果之前已发生过边界拼接，将前缀加上还原完整文本
    const fullText = this._boundaryPrefix !== null ? this._boundaryPrefix + text : text;

    // ★ 回复边界检测：用原始文本做前缀比较，避免 normalizeMediaTags 对未闭合标签
    //   的不稳定处理导致误判（normalize 后的文本在 partial reply 的不同阶段可能产生
    //   完全不同的结果，从而使 startsWith 始终失败，导致 boundary 被反复触发）
    //   检测到新回复时，直接在之前内容后追加两个换行再拼接新内容，继续在同一流式会话中发送
    if (this.lastRawFull && fullText.length > 0 && !fullText.startsWith(this.lastRawFull)) {
      this.logInfo(
        `onPartialReply: reply boundary detected — raw prefix mismatch (new len=${fullText.length}, prev len=${this.lastRawFull.length}), appending with separator`,
      );

      // 记住拼接前缀：之前的全部内容 + "\n\n"，后续回调的 text 都会自动加上此前缀
      this._boundaryPrefix = this.lastRawFull + "\n\n";
      const merged = this._boundaryPrefix + text;
      this.lastRawFull = merged;
      this.lastNormalizedFull = normalizeMediaTags(merged);

      await this.processMediaTags(this.lastNormalizedFull);
      return;
    }

    // 正常增长：更新原始文本和 normalize 后的文本
    this.lastRawFull = fullText;
    this.lastNormalizedFull = normalizeMediaTags(fullText);

    // ★ 核心：从 sentIndex 开始，处理增量文本（串行队列保证不会并发进入）
    await this.processMediaTags(this.lastNormalizedFull);
  }

  /**
   * 处理 deliver 回调
   *
   * ★ 与 onPartialReply 互斥：首先到达的回调锁定控制权，后到的被忽略。
   */
  async onDeliver(payload: { text?: string }): Promise<void> {
    const rawLen = payload.text?.length ?? 0;
    const preview = (payload.text ?? "").slice(0, 60).replace(/\n/g, "\\n");
    this.logDebug(
      `onDeliver: rawLen=${rawLen}, phase=${this.phase}, streamMsgId=${this.streamMsgId}, sentIndex=${this.sentIndex}, sentChunks=${this.sentStreamChunkCount}, firstCB=${this.firstCallbackSource}, preview="${preview}"`,
    );
    if (this.isTerminalPhase) {
      this.logDebug(`onDeliver: skipped (terminal phase)`);
      return;
    }

    const text = payload.text ?? "";
    if (!text.trim()) {
      this.logDebug(`onDeliver: skipped (empty text)`);
      return;
    }

    // ★ 互斥锁
    if (!this.acquireCallbackLock("deliver")) {
      return;
    }

    this.logInfo(`onDeliver: deliver in control, falling back to static`);
    this.transition("aborted", "onDeliver", "deliver_arrived_first_fallback_to_static");
  }

  /**
   * 处理 onIdle 回调（分发完成时调用）
   *
   * ★ 挂到 _callbackChain 上，保证在所有 onPartialReply 执行完之后才执行。
   *
   * onIdle 会传入最终的全量文本。如果该文本**包含**之前存储的 lastNormalizedFull，
   * 说明一致，继续处理剩余内容；否则忽略（防止 onIdle 修改文本导致的不一致）。
   */
  async onIdle(payload?: { text?: string }): Promise<void> {
    if (!this.dispatchFullyComplete) {
      this.logDebug(`onIdle: skipped (dispatch not fully complete)`);
      return;
    }
    if (this.isTerminalPhase) {
      return;
    }

    // 挂到串行队列尾部，等所有 onPartialReply 执行完再处理
    this._callbackChain = this._callbackChain.then(
      () => this._doIdle(payload),
      (err) => {
        this.logError(`onIdle chain error: ${formatStreamErr(err)}`);
        return this._doIdle(payload);
      },
    );
    return this._callbackChain;
  }

  /** onIdle 的实际逻辑（由 _callbackChain 保证在 onPartialReply 之后执行） */
  private async _doIdle(payload?: { text?: string }): Promise<void> {
    this.logDebug(
      `onIdle: dispatchFullyComplete=${this.dispatchFullyComplete}, phase=${this.phase}, streamChunks=${this.sentStreamChunkCount}, mediaCount=${this.sentMediaCount}, sentIndex=${this.sentIndex}`,
    );
    if (this.isTerminalPhase) {
      this.logDebug(`onIdle: skipped (terminal phase)`);
      return;
    }

    // ★ onIdle 文本校验：如果传了文本，检查是否包含之前的全量文本
    if (payload?.text) {
      const idleNormalized = normalizeMediaTags(payload.text);
      if (idleNormalized.includes(this.lastNormalizedFull)) {
        // onIdle 文本包含之前的全量 → 一致，使用 onIdle 的文本作为最终全量
        this.logDebug(
          `onIdle: text contains lastNormalizedFull, updating (${this.lastNormalizedFull.length} → ${idleNormalized.length})`,
        );
        this.lastNormalizedFull = idleNormalized;
      } else if (this.lastNormalizedFull.includes(idleNormalized)) {
        // 之前的全量包含 onIdle 文本 → onIdle 文本是子集，保留之前的
        this.logDebug(`onIdle: lastNormalizedFull contains idle text, keeping current`);
      } else {
        // 不一致 → 忽略 onIdle
        this.logWarn(
          `onIdle: text mismatch with lastNormalizedFull, ignoring onIdle (idle len=${idleNormalized.length}, last len=${this.lastNormalizedFull.length})`,
        );
        // 虽然忽略文本处理，但仍需要终结当前流式会话
        await this.finalizeOnIdle();
        return;
      }
    }

    // ★ 处理 sentIndex 之后的剩余内容
    const remaining = this.lastNormalizedFull.slice(this.sentIndex);
    if (remaining) {
      const hasClosedTag = findFirstClosedMediaTag(remaining);
      if (hasClosedTag) {
        this.logDebug(`onIdle: unprocessed media tags in remaining text, processing now`);
        await this.processMediaTags(this.lastNormalizedFull);
        if (this.isTerminalPhase) {
          return;
        }
      }
    }

    await this.finalizeOnIdle();
  }

  /**
   * onIdle 的终结逻辑：终结流式会话或标记完成/降级
   */
  private async finalizeOnIdle(): Promise<void> {
    // 等待正在进行的流式启动请求完成
    if (this.startingPromise) {
      this.logDebug(`finalizeOnIdle: waiting for pending stream start`);
      await this.startingPromise;
    }
    if (this.isTerminalPhase) {
      return;
    }

    // 等待所有 pending flush 完成
    await this.flush.waitForFlush();

    // ---- 判断如何终结 ----
    if (this.streamMsgId) {
      // 有活跃流式会话 → 发终结分片
      this.transition("completed", "onIdle", "normal");
      try {
        // 当前会话的显示内容 = sentIndex 之后的纯文本（去掉未闭合标签）
        const sessionText = this.lastNormalizedFull.slice(this.sentIndex);
        const [safeText] = stripIncompleteMediaTag(sessionText);
        this.logDebug(`finalizeOnIdle: sending DONE chunk, len=${safeText.length}`);
        await this.sendStreamChunk(safeText, StreamInputState.DONE, "onIdle");
        this.logInfo(`streaming completed, final text length: ${safeText.length}`);
      } catch (err) {
        this.logError(`failed to send final stream chunk: ${formatStreamErr(err)}`);
      }
    } else if (this.sentStreamChunkCount > 0) {
      // 没有活跃流式会话，但之前发过流式分片或媒体 → 正常完成
      this.logInfo(
        `finalizeOnIdle: no active stream session, but sent ${this.sentStreamChunkCount} chunks (including ${this.sentMediaCount} media), marking completed`,
      );
      this.transition("completed", "onIdle", "no_active_session_but_sent");
    } else {
      // 什么都没发过 → 降级
      this.logInfo(`no chunk or media sent, marking fallback to static`);
      this.transition("aborted", "onIdle", "fallback_to_static_nothing_sent");
    }
  }

  /**
   * 处理错误
   */
  async onError(err: unknown): Promise<void> {
    this.logError(`reply error: ${formatStreamErr(err)}`);

    if (this.isTerminalPhase) {
      return;
    }

    // 等待正在进行的流式启动请求完成
    if (this.startingPromise) {
      this.logDebug(`onError: waiting for pending stream start`);
      await this.startingPromise;
    }

    if (this.isTerminalPhase) {
      return;
    }

    // 如果从未发出任何内容 → 降级
    if (this.sentStreamChunkCount === 0) {
      this.logInfo(`no chunk or media sent, marking fallback to static for error handling`);
      this.transition("aborted", "onError", "fallback_to_static_error");
      return;
    }

    // 如果有活跃流式会话，发送错误终结分片
    if (this.streamMsgId) {
      try {
        const sessionText = this.lastNormalizedFull.slice(this.sentIndex);
        const [safeText] = stripIncompleteMediaTag(sessionText);
        const errorText = safeText
          ? `${safeText}\n\n---\n**Error**: 生成响应时发生错误。`
          : "**Error**: 生成响应时发生错误。";
        await this.sendStreamChunk(errorText, StreamInputState.DONE, "onError");
      } catch (sendErr) {
        this.logError(`failed to send error stream chunk: ${formatStreamErr(sendErr)}`);
      }
    }

    this.transition("completed", "onError", "error");
    await this.flush.waitForFlush();
  }

  // ------------------------------------------------------------------
  // 外部控制
  // ------------------------------------------------------------------

  /** 标记分发已全部完成 */
  markFullyComplete(): void {
    this.dispatchFullyComplete = true;
  }

  /** 中止流式消息 */
  async abortStreaming(): Promise<void> {
    if (!this.transition("aborted", "abortStreaming", "abort")) {
      return;
    }

    await this.flush.waitForFlush();

    if (this.streamMsgId) {
      try {
        const sessionText = this.lastNormalizedFull.slice(this.sentIndex);
        const [safeText] = stripIncompleteMediaTag(sessionText);
        const abortText = safeText || "（已中止）";
        await this.sendStreamChunk(abortText, StreamInputState.DONE, "abortStreaming");
        this.logInfo(`streaming aborted, sent final chunk`);
      } catch (err) {
        this.logError(`abort send failed: ${formatStreamErr(err)}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // 内部：富媒体标签中断/恢复
  // ------------------------------------------------------------------

  /**
   * 处理富媒体标签（循环消费模型）
   *
   * 从 sentIndex 开始，对增量文本：
   * 1. 优先找闭合标签 → 终结当前流式 → 同步发媒体 → 推进 sentIndex → reset → 继续
   * 2. 没有闭合标签但有未闭合前缀 → 标签前的安全文本仍需通过流式发送 → 推进 sentIndex → 等待标签闭合
   * 3. 纯文本 → 触发流式发送（performFlush 会动态计算要发的内容）
   */
  private async processMediaTags(normalizedFull: string): Promise<void> {
    try {
      // ---- 1. 循环消费所有已闭合的媒体标签 ----
      while (true) {
        if (this.isTerminalPhase) {
          return;
        }

        const incremental = normalizedFull.slice(this.sentIndex);
        const found = findFirstClosedMediaTag(incremental);

        if (!found) {
          break;
        }

        this.logInfo(
          `processMediaTags: found <${found.tagName}> at offset ${this.sentIndex}, textBefore="${found.textBefore.slice(0, 40)}"`,
        );

        // ---- 1.1 终结当前流式会话（如果有的话） ----
        // endCurrentStreamIfNeeded 会用 sentIndex 到标签前文本结束的位置来发送终结分片
        // 先临时推进 sentIndex 到标签前文本结束的位置（用于终结分片的内容计算）
        // 不，我们不需要推进——endCurrentStreamIfNeeded 发的是从 sentIndex 开始到当前文本前部分
        // 实际上需要把 textBefore 的内容加入到当前会话的显示范围
        // 终结时 performFlush/sendStreamChunk 用 lastNormalizedFull.slice(sentIndex) 中 textBefore 之前的部分
        // 但 endCurrentStreamIfNeeded 需要知道要发到哪里……

        // 简化：计算标签前文本在全量中的结束位置
        const textBeforeEndInFull = this.sentIndex + found.textBefore.length;

        await this.endCurrentStreamIfNeeded("processMediaTags:closedTag", textBeforeEndInFull);
        if (this.isTerminalPhase) {
          return;
        }

        // ---- 1.2 同步发送媒体文件 ----
        if (found.mediaPath && this.deps.mediaContext) {
          const item: SendQueueItem = { type: found.itemType, content: found.mediaPath };
          this.logDebug(
            `processMediaTags: sending ${found.itemType}: ${found.mediaPath.slice(0, 80)}`,
          );
          await sendMediaQueue([item], this.deps.mediaContext);
          this.sentMediaCount++;
          this.sentStreamChunkCount++;
          this.logDebug(
            `processMediaTags: media sent, sentMediaCount=${this.sentMediaCount}, sentStreamChunkCount=${this.sentStreamChunkCount}`,
          );
        } else if (found.mediaPath && !this.deps.mediaContext) {
          this.logWarn(`processMediaTags: no mediaContext provided, cannot send ${found.itemType}`);
        }

        // ---- 1.3 推进 sentIndex，重置流式状态 ----
        this.sentIndex += found.tagEndIndex;
        this.logDebug(`processMediaTags: sentIndex updated to ${this.sentIndex}`);
        this.resetStreamSession();
      }

      // ---- 循环结束：没有更多闭合标签 ----
      const remaining = normalizedFull.slice(this.sentIndex);

      if (!remaining) {
        this.logDebug(`processMediaTags: no remaining text after media tags`);
        return;
      }

      // ---- 2. 检查是否有未闭合的标签前缀 ----
      const [safeText, hasIncomplete] = stripIncompleteMediaTag(remaining);

      if (hasIncomplete) {
        this.logDebug(
          `processMediaTags: incomplete tag detected, safe text len=${safeText.length}, remaining len=${remaining.length}`,
        );
        // 不终结流式会话！继续正常流式发送安全文本部分（performFlush 中也有
        // stripIncompleteMediaTag 保护，会自动只发送安全部分）。
        // 等下次 onPartialReply 带来更多文本后，标签会闭合或被识别为非媒体标签。
      }

      // ---- 3. 文本 → 触发流式发送 ----
      // performFlush 会动态计算 lastNormalizedFull.slice(sentIndex) 的安全部分来发送
      this.logDebug(
        `processMediaTags: ${hasIncomplete ? "incomplete tag, sending safe text" : "pure text"}, remaining len=${remaining.length}`,
      );

      if (!remaining.trim()) {
        // 纯空白文本 → 不启动流式
        this.logDebug(`processMediaTags: pure whitespace, skipping stream start`);
        return;
      }

      await this.ensureStreamingStarted(normalizedFull.length);
      if (this.isTerminalPhase) {
        return;
      }
      await this.flush.throttledUpdate(this.throttleMs);
    } catch (err) {
      this.logError(`processMediaTags failed: ${formatStreamErr(err)}`);
    }
  }

  /**
   * 终结当前流式会话（如果有的话）
   *
   * @param caller 调用者标识（日志用）
   * @param textEndInFull 本次终结需要发送到的全量文本位置（不含）。
   *   终结分片的内容 = lastNormalizedFull.slice(sentIndex, textEndInFull)
   *
   * 逻辑：
   * - 有活跃 streamMsgId → 等待 flush 完成 → 发 DONE 分片终结
   * - 没有 streamMsgId 但有非空白文本 → 启动流式 → 立即终结
   * - 纯空白且无活跃流式 → 不发送
   */
  private async endCurrentStreamIfNeeded(caller: string, textEndInFull: number): Promise<void> {
    // 先等待启动完成
    if (this.startingPromise) {
      this.logDebug(`${caller}: waiting for pending stream start`);
      await this.startingPromise;
    }

    // 停止所有 flush 活动
    await this.flush.cancelPendingAndWait();

    // 计算当前会话要发的文本
    const sessionText = this.lastNormalizedFull.slice(this.sentIndex, textEndInFull);
    const [safeText] = stripIncompleteMediaTag(sessionText);

    if (this.streamMsgId) {
      // 有活跃流式会话 → 终结它
      try {
        await this.sendStreamChunk(safeText, StreamInputState.DONE, caller);
        this.logDebug(`${caller}: current stream session ended`);
      } catch (err) {
        this.logError(`${caller}: failed to end stream: ${formatStreamErr(err)}`);
      }
    } else if (safeText && safeText.trim()) {
      // 没有活跃流式会话，但有非空白文本未发送 → 启动流式 → 立即终结
      // 先临时存储到 _pendingSessionText 以便 doStartStreaming 使用
      this._pendingSessionText = safeText;
      await this.ensureStreamingStarted(textEndInFull);
      this._pendingSessionText = null;
      if (this.isTerminalPhase) {
        return;
      }
      if (this.startingPromise) {
        await this.startingPromise;
      }
      if (this.streamMsgId) {
        try {
          await this.sendStreamChunk(safeText, StreamInputState.DONE, caller);
          this.logDebug(`${caller}: started and ended stream for pre-tag text`);
        } catch (err) {
          this.logError(`${caller}: failed to send pre-tag text: ${formatStreamErr(err)}`);
        }
      }
    }
    // 如果纯空白且没有活跃流式 → 不发送
  }

  /** 临时存储 endCurrentStreamIfNeeded 需要立即发送的文本（用于 doStartStreaming） */
  private _pendingSessionText: string | null = null;

  /**
   * 重置流式会话状态（用于媒体中断后恢复）
   *
   * 只重置会话相关状态，不重置 sentIndex 和 dispatch 标记。
   * 新流式会话从当前 sentIndex 开始（performFlush 动态计算内容）。
   */
  private resetStreamSession(): void {
    const prevPhase = this.phase;
    this.phase = "idle";
    this.logDebug(
      `phase: ${prevPhase} → idle (source: resetStreamSession, forced reset for media resume)`,
    );
    this.streamMsgId = null;
    this.streamIndex = 0;
    this.msgSeq = null;
    this.startingPromise = null;
    this.flush.reset(() => this.performFlush());
    // 注意：不重置 sentIndex、lastNormalizedFull、dispatchFullyComplete、sentStreamChunkCount、sentMediaCount
  }

  // ------------------------------------------------------------------
  // 内部：流式会话管理
  // ------------------------------------------------------------------

  /** 确保流式会话已开始（首次调用创建；并发调用者会等待首次完成） */
  private async ensureStreamingStarted(textEndInFull: number): Promise<void> {
    if (this.streamMsgId || this.isTerminalPhase) {
      return;
    }

    if (this.startingPromise) {
      this.logDebug(`ensureStreamingStarted: waiting for pending start request`);
      await this.startingPromise;
      return;
    }

    if (!this.transition("streaming", "ensureStreamingStarted")) {
      return;
    }

    this.startingPromise = this.doStartStreaming(textEndInFull);
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = null;
    }
  }

  /** 实际执行流式启动逻辑 */
  private async doStartStreaming(textEndInFull: number): Promise<void> {
    try {
      // 计算当前会话要发送的文本
      // 优先使用 _pendingSessionText（endCurrentStreamIfNeeded 需要立即发送的文本）
      // 否则使用调用处预先确定的 sentIndex → textEndInFull 范围
      const sessionText =
        this._pendingSessionText ?? this.lastNormalizedFull.slice(this.sentIndex, textEndInFull);
      const [safeText] = stripIncompleteMediaTag(sessionText);

      // 全空白文本 → 不开启流式，退回 idle
      if (!safeText?.trim()) {
        this.logDebug(`doStartStreaming: skipped (session text is empty or whitespace-only)`);
        this.transition("idle", "doStartStreaming", "whitespace_only_text");
        return;
      }
      const firstText = safeText;
      const resp = await this.sendStreamChunk(
        firstText,
        StreamInputState.GENERATING,
        "doStartStreaming",
      );

      if (!resp.id) {
        throw new Error(`Stream API returned no id: ${JSON.stringify(resp)}`);
      }

      this.streamMsgId = resp.id;
      this.flush.setReady(true);
      this.logInfo(`stream started, stream_msg_id=${resp.id}`);
    } catch (err) {
      this.logError(`failed to start streaming: ${formatStreamErr(err)}`);
      this.transition("idle", "doStartStreaming", "start_failed_will_retry");
    }
  }

  /** 发送一个流式分片（不做任何文本修改） */
  private async sendStreamChunk(
    content: string,
    inputState: StreamInputState,
    caller: string,
  ): Promise<MessageResponse> {
    this.logDebug(
      `sendStreamChunk: caller=${caller}, inputState=${inputState}, contentLen=${content.length}, streamMsgId=${this.streamMsgId}, index=${this.streamIndex}`,
    );

    // 同一流式会话内所有 chunk 共享同一个 msgSeq；新会话首次发送时生成
    if (this.msgSeq === null) {
      this.msgSeq = getNextMsgSeq(this.deps.replyToMsgId);
    }
    const currentIndex = this.streamIndex++;

    const api = getMessageApi(this.deps.account.appId);
    const creds = {
      appId: this.deps.account.appId,
      clientSecret: this.deps.account.clientSecret,
    };
    const resp = await api.sendC2CStreamMessage(creds, this.deps.userId, {
      input_mode: StreamInputMode.REPLACE,
      input_state: inputState,
      content_type: StreamContentType.MARKDOWN,
      content_raw: content,
      event_id: this.deps.eventId,
      msg_id: this.deps.replyToMsgId,
      stream_msg_id: this.streamMsgId ?? undefined,
      msg_seq: this.msgSeq,
      index: currentIndex,
    });

    // 分片发送成功
    this.sentStreamChunkCount++;

    return resp;
  }

  // ------------------------------------------------------------------
  // 内部：flush 实现
  // ------------------------------------------------------------------

  /** 执行一次实际的流式内容更新 */
  private async performFlush(): Promise<void> {
    this.logDebug(
      `performFlush: phase=${this.phase}, streamMsgId=${this.streamMsgId}, sentIndex=${this.sentIndex}`,
    );
    if (!this.streamMsgId || this.isTerminalPhase) {
      this.logDebug(
        `performFlush: skipped (streamMsgId=${this.streamMsgId}, terminal=${this.isTerminalPhase})`,
      );
      return;
    }

    // 动态计算当前会话要发送的文本 = 从 sentIndex 开始的增量
    const sessionText = this.lastNormalizedFull.slice(this.sentIndex);
    if (!sessionText) {
      this.logDebug(`performFlush: skipped (empty session text)`);
      return;
    }

    // 安全检查：确保不会把未闭合的媒体标签前缀发给用户
    const [safeText, hasIncomplete] = stripIncompleteMediaTag(sessionText);
    if (hasIncomplete) {
      this.logDebug(
        `flush: detected incomplete media tag, sending safe text (${safeText.length}/${sessionText.length} chars)`,
      );
    }
    if (!safeText) {
      this.logDebug(`performFlush: skipped (safeText empty after stripIncompleteMediaTag)`);
      return;
    }

    this.logDebug(`performFlush: sending chunk, safeText len=${safeText.length}`);
    try {
      await this.sendStreamChunk(safeText, StreamInputState.GENERATING, "performFlush");
      this.logDebug(`performFlush: chunk sent OK, sentStreamChunks=${this.sentStreamChunkCount}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logError(`stream flush failed, will retry on next scheduled flush: ${msg}`);
    }
  }
}

// ============ 辅助函数 ============

// ============ 流式媒体发送 ============

/** 流式媒体发送上下文（由 gateway 注入到 StreamingController） */
export interface StreamingMediaContext {
  /** 账户信息 */
  account: GatewayAccount;
  /** 事件信息 */
  event: {
    type: "c2c" | "group" | "channel";
    senderId: string;
    messageId: string;
    groupOpenid?: string;
    channelId?: string;
  };
  /** 日志 */
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 将 StreamingMediaContext 转换为公共的 MediaSendContext
 */
function toMediaSendContext(ctx: StreamingMediaContext): MediaSendContext {
  const { account, event, log } = ctx;

  const mediaTarget: MediaTargetContext = {
    targetType: event.type,
    targetId:
      event.type === "c2c"
        ? event.senderId
        : event.type === "group"
          ? event.groupOpenid!
          : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: `[qqbot:${account.accountId}]`,
  };

  const qualifiedTarget =
    event.type === "group" ? `qqbot:group:${event.groupOpenid}` : `qqbot:c2c:${event.senderId}`;

  return {
    mediaTarget,
    qualifiedTarget,
    account,
    replyToId: event.messageId,
    log,
  };
}

/**
 * 按顺序发送媒体队列中的所有项（流式场景专用）
 */
async function sendMediaQueue(queue: SendQueueItem[], ctx: StreamingMediaContext): Promise<void> {
  const sendCtx = toMediaSendContext(ctx);

  await executeSendQueue(queue, sendCtx, {
    // 流式场景下跳过 inter-tag 文本（由新流式会话处理）
    skipInterTagText: true,
  });
}

// ============ 流式模式判断 ============

/**
 * 是否对私聊走 QQ 官方 C2C `stream_messages` 流式 API。
 * - `streaming: true` 等效于 `mode: "partial"` 且 `c2cStreamApi: true`。
 * - 仍支持对象里显式设 `c2cStreamApi: true` 以兼容旧配置；仅 C2C 场景生效。
 */
export function shouldUseOfficialC2cStream(
  account: GatewayAccount,
  targetType: "c2c" | "group" | "channel",
): boolean {
  if (targetType !== "c2c") {
    return false;
  }
  const s = account.config?.streaming;
  if (s === true) {
    return true;
  }
  if (s && typeof s === "object" && s.c2cStreamApi === true) {
    return true;
  }
  return false;
}
