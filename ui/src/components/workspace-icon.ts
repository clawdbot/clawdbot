import { html } from "lit";
import { property, state } from "lit/decorators.js";
import { AuthenticatedAvatarRouteLoader } from "../lib/authenticated-avatar-route.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

/**
 * Workspace identity mark: the project's own icon when the Gateway found one in
 * the session workspace, otherwise the generic folder glyph. Most workspaces
 * have no project icon, so the route answering 404 is an ordinary outcome and
 * the glyph is the recorded fallback rather than an error state.
 */
class WorkspaceIcon extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) routeUrl: string | null = null;
  /** Ordered credential candidates; a stale saved token falls through to the session password. */
  @property({ attribute: false }) authTokens: readonly string[] = [];
  @property({ attribute: false }) authReady = false;
  /** Route whose bytes the browser refused to decode; keyed so a new session retries. */
  @state() private undecodableRouteUrl: string | null = null;
  private readonly loader = new AuthenticatedAvatarRouteLoader(
    () => {
      if (this.isConnected) {
        this.requestUpdate();
      }
    },
    { cacheNotFound: true, retryUnavailable: true },
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
      return icons.folder;
    }
    // <img> never executes script, which is what keeps SVG project icons safe
    // to paint; the route's sandbox policy covers direct navigation to them.
    return html`<img
      class="workspace-icon"
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

if (!customElements.get("openclaw-workspace-icon")) {
  customElements.define("openclaw-workspace-icon", WorkspaceIcon);
}
