/** Periodically refresh C2C typing state while a response is still in progress. */

import { sendC2CInputNotify } from "./api.js";

// Refresh every 50s for the QQ API's 60s input-notify window.
export const TYPING_INTERVAL_MS = 50_000;
export const TYPING_INPUT_SECOND = 60;

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly clearCache: () => void,
    private readonly openid: string,
    private readonly msgId: string | undefined,
    private readonly log?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    },
    private readonly logPrefix = "[qqbot]",
  ) {}

  /** Start periodic keep-alive sends. */
  start(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.stopped) {
        this.stop();
        return;
      }
      this.send().catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  /** Stop periodic keep-alive sends. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async send(): Promise<void> {
    try {
      const token = await this.getToken();
      await sendC2CInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
      this.log?.debug?.(`${this.logPrefix} Typing keep-alive sent to ${this.openid}`);
    } catch (err) {
      try {
        this.clearCache();
        const token = await this.getToken();
        await sendC2CInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
      } catch {
        this.log?.debug?.(
          `${this.logPrefix} Typing keep-alive failed for ${this.openid}: ${String(err)}`,
        );
      }
    }
  }
}
