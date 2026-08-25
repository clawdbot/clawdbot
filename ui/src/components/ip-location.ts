import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { lookupClientGeolocation, type ClientGeolocation } from "../lib/geolocation-lookup.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

// The first lookup on a fresh Gateway waits on a database download that can take
// a minute, so an unavailable answer is retried on a widening delay instead of
// leaving the row permanently blank until someone reloads the page.
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Renders the coarse city for one client address, or nothing at all. Absence is
 * a normal outcome — no plugin installed, or an address the database cannot
 * place — so this never shows a spinner or an error state.
 */
class OpenClawIpLocation extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) ip: string | undefined;
  @state() private location: ClientGeolocation | null = null;

  private requestedIp: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.clearRetry();
  }

  override willUpdate() {
    const ip = this.ip?.trim();
    if (!ip || ip === this.requestedIp) {
      return;
    }
    this.clearRetry();
    this.requestedIp = ip;
    this.retryAttempt = 0;
    this.location = null;
    this.resolve(ip);
  }

  private clearRetry() {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private resolve(ip: string) {
    void lookupClientGeolocation(ip).then((result) => {
      // A later address may have won while this request was in flight.
      if (this.requestedIp !== ip) {
        return;
      }
      if (result.status === "located") {
        this.location = result.location;
        return;
      }
      if (result.status === "absent") {
        return;
      }
      const delay = RETRY_DELAYS_MS[this.retryAttempt];
      if (delay === undefined) {
        return;
      }
      this.retryAttempt += 1;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (this.requestedIp === ip && this.isConnected) {
          this.resolve(ip);
        }
      }, delay);
    });
  }

  override render() {
    const label = [this.location?.city, this.location?.region ?? this.location?.country]
      .filter(Boolean)
      .join(", ");
    if (!label) {
      return nothing;
    }
    const attribution = this.location?.attribution;
    return html`<span class="activity-feed__device-location"
      >${label}${attribution
        ? html`<a
            class="activity-feed__device-attribution"
            href=${attribution.url}
            target="_blank"
            rel="noreferrer noopener"
            title=${attribution.text}
            >ⓘ</a
          >`
        : nothing}</span
    >`;
  }
}

if (globalThis.customElements) {
  // Guarded define matches the other presence components: the module is
  // imported from more than one view and must not re-register.
  if (!customElements.get("openclaw-ip-location")) {
    customElements.define("openclaw-ip-location", OpenClawIpLocation);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-ip-location": OpenClawIpLocation;
  }
}
