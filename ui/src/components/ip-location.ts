import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { lookupClientGeolocation, type ClientGeolocation } from "../lib/geolocation-lookup.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

/**
 * Renders the coarse city for one client address, or nothing at all. Absence is
 * the normal case — no plugin installed, no database yet, or an address the
 * database cannot place — so this never shows a spinner or an error state.
 */
class OpenClawIpLocation extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) ip: string | undefined;
  @state() private location: ClientGeolocation | null = null;

  private requestedIp: string | undefined;

  override willUpdate() {
    const ip = this.ip?.trim();
    if (!ip || ip === this.requestedIp) {
      return;
    }
    this.requestedIp = ip;
    this.location = null;
    void lookupClientGeolocation(ip).then((result) => {
      // A later address may have won while this request was in flight.
      if (this.requestedIp === ip) {
        this.location = result;
      }
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
