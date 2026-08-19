import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { AuthenticatedAvatarRouteLoader } from "../lib/authenticated-avatar-route.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

/** Channel conversation image loaded from the Gateway's authenticated proxy route. */
class ChannelAvatar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) routeUrl: string | null = null;
  @property({ attribute: false }) authTokens: readonly string[] = [];
  @property({ attribute: false }) authReady = false;
  /** Shown while no avatar blob is usable (loading, missing auth, 404). */
  @property({ attribute: false }) fallback: TemplateResult | typeof nothing = nothing;
  @state() private undecodableRouteUrl: string | null = null;
  private readonly loader = new AuthenticatedAvatarRouteLoader(
    () => {
      if (this.isConnected) {
        this.requestUpdate();
      }
    },
    { cacheNotFound: true },
  );

  override disconnectedCallback() {
    this.loader.reset();
    super.disconnectedCallback();
  }

  override render() {
    return this.loader.withActiveRoutes(() => this.renderContent());
  }

  private renderContent() {
    const routeUrl = this.routeUrl;
    const blobUrl =
      routeUrl && this.authReady && this.undecodableRouteUrl !== routeUrl
        ? this.loader.resolve(routeUrl, this.authTokens)
        : null;
    if (!blobUrl) {
      return this.fallback;
    }
    return html`<img
      class="channel-avatar"
      src=${blobUrl}
      alt=""
      aria-hidden="true"
      decoding="async"
      @error=${() => {
        this.undecodableRouteUrl = routeUrl;
      }}
    />`;
  }
}

if (!customElements.get("openclaw-channel-avatar")) {
  customElements.define("openclaw-channel-avatar", ChannelAvatar);
}
