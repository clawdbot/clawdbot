/**
 * Periodically refresh C2C typing state while a response is in progress.
 *
 * All I/O operations are injected via constructor parameters so this
 * module has zero external dependencies and can run in both plugin versions.
 */

import { formatErrorMessage } from "../utils/format.js";

/** Function that sends a typing indicator to one user. */
export type SendInputNotifyFn = (
  token: string,
  openid: string,
  msgId: string | undefined,
  inputSecond: number,
) => Promise<unknown>;

/** Refresh every 50s for the QQ API's 60s input-notify window. */
export const TYPING_INTERVAL_MS = 50_000;
export const TYPING_INPUT_SECOND = 60;

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly clearCache: () => void,
    private readonly sendInputNotify: SendInputNotifyFn,
    private readonly openid: string,
    private readonly msgId: string | undefined,
    private readonly log?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    },
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
      await this.sendInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
      this.log?.debug?.(`Typing keep-alive sent to ${this.openid}`);
    } catch (err) {
      try {
        this.clearCache();
        const token = await this.getToken();
        await this.sendInputNotify(token, this.openid, this.msgId, TYPING_INPUT_SECOND);
      } catch {
        this.log?.debug?.(
          `Typing keep-alive failed for ${this.openid}: ${formatErrorMessage(err)}`,
        );
      }
    }
  }
}
