/**
 * Periodically refresh C2C typing state while a response is in progress.
 *
 * Interval scheduling comes from the core typing keepalive loop; this module
 * owns the QQ passive-reply budget accounting and token-refresh retry.
 */

import { createTypingKeepaliveLoop } from "openclaw/plugin-sdk/channel-outbound";
import { claimMessageReply } from "../messaging/outbound-reply.js";
import type { ReplyLimitResult } from "../messaging/reply-limiter.js";
import { formatErrorMessage } from "../utils/format.js";

/** Function that sends a typing indicator to one user. */
type SendInputNotifyFn = (
  token: string,
  openid: string,
  msgId: string | undefined,
  inputSecond: number,
) => Promise<unknown>;

/** Refresh every 5s for the QQ API's 10s input-notify window. */
const TYPING_INTERVAL_MS = 5_000;
export const TYPING_INPUT_SECOND = 10;
const QQ_C2C_PASSIVE_REPLY_LIMIT = 5;
const INITIAL_TYPING_NOTIFY_COUNT = 1;
const FINAL_REPLY_RESERVE_COUNT = 1;
export const TYPING_RENEWAL_LIMIT =
  QQ_C2C_PASSIVE_REPLY_LIMIT - INITIAL_TYPING_NOTIFY_COUNT - FINAL_REPLY_RESERVE_COUNT;

export class TypingKeepAlive {
  private stopped = false;
  // Core loop owns the interval and in-flight tick suppression; budget
  // accounting in sendAttempt() decides when it must stop for good.
  private readonly loop = createTypingKeepaliveLoop({
    intervalMs: TYPING_INTERVAL_MS,
    onTick: () => this.send(),
  });

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly clearCache: () => void,
    private readonly sendInputNotify: SendInputNotifyFn,
    private readonly openid: string,
    private readonly msgId: string,
    private readonly log?: { debug?: (msg: string) => void },
    private readonly claimPassiveReply: (
      messageId: string,
      reserve: number,
    ) => ReplyLimitResult = claimMessageReply,
  ) {}

  /** Start periodic keep-alive sends. */
  start(): void {
    // stop() is a permanent latch: a stopped keepalive must never spend more budget.
    if (!this.stopped) {
      this.loop.start();
    }
  }

  /** Stop periodic keep-alive sends. */
  stop(): void {
    this.stopped = true;
    this.loop.stop();
  }

  // Never rejects: the core loop does not catch onTick errors.
  private async send(): Promise<void> {
    try {
      const token = await this.getToken();
      await this.sendAttempt(token);
    } catch (err) {
      try {
        this.clearCache();
        const token = await this.getToken();
        await this.sendAttempt(token);
      } catch {
        this.log?.debug?.(
          `Typing keep-alive failed for ${this.openid}: ${formatErrorMessage(err)}`,
        );
      }
    }
  }

  private async sendAttempt(token: string): Promise<void> {
    if (this.stopped) {
      return;
    }

    // Claim before every wire attempt: a failed request may still have consumed
    // QQ's msg_id budget, while the final text slot must remain available.
    const claim = this.claimPassiveReply(this.msgId, FINAL_REPLY_RESERVE_COUNT);
    if (!claim.allowed) {
      this.log?.debug?.(`Typing keep-alive budget exhausted for ${this.openid}`);
      this.stop();
      return;
    }
    try {
      await this.sendInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
      this.log?.debug?.(`Typing keep-alive sent to ${this.openid}`);
    } finally {
      if (claim.remaining <= FINAL_REPLY_RESERVE_COUNT) {
        this.log?.debug?.(`Typing keep-alive budget exhausted for ${this.openid}`);
        this.stop();
      }
    }
  }
}
