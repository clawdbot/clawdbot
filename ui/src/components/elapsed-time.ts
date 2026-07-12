// Live elapsed-time label that ticks once per second while the work runs.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { formatDurationCompact } from "../lib/format.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

class ElapsedTime extends OpenClawLightDomContentsElement {
  @property({ type: Number }) startMs: number | null = null;
  @property({ type: Number }) endMs: number | null = null;

  private timer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.syncTimer();
  }

  override disconnectedCallback() {
    this.stopTimer();
    super.disconnectedCallback();
  }

  override updated() {
    this.syncTimer();
  }

  private syncTimer() {
    const ticking = this.isConnected && this.startMs != null && this.endMs == null;
    if (ticking && this.timer == null) {
      this.timer = window.setInterval(() => this.requestUpdate(), 1_000);
    } else if (!ticking) {
      this.stopTimer();
    }
  }

  private stopTimer() {
    if (this.timer != null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  override render() {
    const start = this.startMs;
    if (start == null) {
      return nothing;
    }
    const end = this.endMs ?? Date.now();
    // Sub-second elapsed reads as "1s", not a millisecond counter.
    return html`${formatDurationCompact(Math.max(1_000, end - start), { spaced: true })}`;
  }
}

if (!customElements.get("openclaw-elapsed-time")) {
  customElements.define("openclaw-elapsed-time", ElapsedTime);
}
