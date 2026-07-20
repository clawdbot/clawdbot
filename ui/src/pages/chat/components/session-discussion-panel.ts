import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionDiscussionInfo,
  SessionDiscussionState,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

export type SessionDiscussionInfoLoader = (sessionKey: string) => Promise<SessionDiscussionInfo>;
export type SessionDiscussionOpener = (sessionKey: string) => Promise<SessionDiscussionInfo>;
export type SessionDiscussionStateListener = (
  sessionKey: string,
  discussionState: SessionDiscussionState,
) => void;

function resolveDiscussionUrl(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// The frame runs with allow-scripts + allow-same-origin (cookies must flow for
// the discussion app's session). A same-origin src would therefore inherit THIS
// app's origin and could reach the parent DOM and gateway credentials — reject
// it; cross-origin same-site hosts (the supported topology) pass.
function resolveDiscussionEmbedUrl(value: string | undefined): string | null {
  const resolved = resolveDiscussionUrl(value);
  if (!resolved) {
    return null;
  }
  return new URL(resolved).origin === window.location.origin ? null : resolved;
}

class SessionDiscussionPanel extends OpenClawLightDomElement {
  @property() sessionKey = "";
  @property({ attribute: false }) loadInfo: SessionDiscussionInfoLoader | null = null;
  @property({ attribute: false }) openDiscussion: SessionDiscussionOpener | null = null;
  @property({ attribute: false }) onStateChange: SessionDiscussionStateListener | null = null;
  @property({ type: Boolean }) canOpen = true;

  @state() private info: SessionDiscussionInfo | null = null;
  @state() private loading = false;
  @state() private opening = false;
  @state() private error: string | null = null;

  private requestVersion = 0;

  private isCurrentRequest(sessionKey: string, version: number): boolean {
    return version === this.requestVersion && sessionKey === this.sessionKey.trim();
  }

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("sessionKey") || changed.has("loadInfo")) {
      void this.refresh();
      return;
    }
    // Gaining write access after an available discussion resolved must still
    // open it: refresh() already ran, and without the removed manual button
    // nothing else would ever call the opener.
    if (changed.has("canOpen") && this.canOpen && this.info?.state === "available") {
      void this.open(this.sessionKey.trim(), this.requestVersion);
    }
  }

  // requestKey is the key the request was issued for; the sessionKey property
  // may already name the next session while an old result resolves, and a
  // stale result must not be attributed to (or close the panel of) the new one.
  private publish(requestKey: string, info: SessionDiscussionInfo): void {
    if (requestKey !== this.sessionKey.trim()) {
      return;
    }
    this.info = info;
    this.onStateChange?.(requestKey, info.state);
  }

  private async refresh(): Promise<void> {
    const loader = this.loadInfo;
    const sessionKey = this.sessionKey.trim();
    const version = ++this.requestVersion;
    this.info = null;
    this.error = null;
    this.opening = false;
    if (!loader || !sessionKey) {
      this.loading = false;
      return;
    }
    this.loading = true;
    try {
      const info = await loader(sessionKey);
      if (this.isCurrentRequest(sessionKey, version)) {
        this.publish(sessionKey, info);
        this.loading = false;
        if (info.state === "available" && this.canOpen) {
          await this.open(sessionKey, version);
        }
      }
    } catch (error) {
      if (this.isCurrentRequest(sessionKey, version)) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.isCurrentRequest(sessionKey, version)) {
        this.loading = false;
      }
    }
  }

  private async open(sessionKey: string, version: number): Promise<void> {
    const opener = this.openDiscussion;
    if (!opener || !sessionKey || this.opening || !this.isCurrentRequest(sessionKey, version)) {
      return;
    }
    this.opening = true;
    this.error = null;
    try {
      const info = await opener(sessionKey);
      if (this.isCurrentRequest(sessionKey, version)) {
        this.publish(sessionKey, info);
      }
    } catch (error) {
      if (this.isCurrentRequest(sessionKey, version)) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.isCurrentRequest(sessionKey, version)) {
        this.opening = false;
      }
    }
  }

  // The iframe sandbox must include allow-same-origin: without it the frame
  // gets an opaque origin, the discussion app's session cookie is never sent,
  // and the embed is stuck on its sign-in card.
  private renderOpen(info: SessionDiscussionInfo): TemplateResult {
    const embedUrl = resolveDiscussionEmbedUrl(info.embedUrl);
    const openUrl = resolveDiscussionUrl(info.openUrl);
    return html`
      <div class="session-discussion__open">
        <div class="session-discussion__header">
          <span>${t("chat.sessionDiscussion.opened")}</span>
          ${openUrl
            ? html`
                <openclaw-tooltip .content=${t("chat.sessionDiscussion.openExternal")}>
                  <a
                    class="btn btn--ghost btn--icon session-discussion__external"
                    href=${openUrl}
                    target="_blank"
                    rel="noopener"
                    aria-label=${t("chat.sessionDiscussion.openExternal")}
                  >
                    ${icons.externalLink}
                  </a>
                </openclaw-tooltip>
              `
            : nothing}
        </div>
        ${embedUrl
          ? html`
              <iframe
                class="session-discussion__frame"
                src=${embedUrl}
                title=${t("chat.sessionDiscussion.frameTitle")}
                sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              ></iframe>
            `
          : html`<div class="session-discussion__empty">
              ${t("chat.sessionDiscussion.unavailable")}
            </div>`}
      </div>
    `;
  }

  override render() {
    if (this.error) {
      return html`<div class="session-discussion__empty">
        <div class="callout danger">${this.error}</div>
      </div>`;
    }
    if (this.loading || !this.info) {
      return html`<div class="session-discussion__empty">
        ${t("chat.sessionDiscussion.loading")}
      </div>`;
    }
    if (this.info.state === "none") {
      return nothing;
    }
    if (this.info.state === "available") {
      return html`<div class="session-discussion__empty">
        ${this.canOpen
          ? t("chat.sessionDiscussion.opening")
          : t("chat.sessionDiscussion.requiresWriteAccess")}
      </div>`;
    }
    return this.renderOpen(this.info);
  }
}

if (!customElements.get("openclaw-session-discussion")) {
  customElements.define("openclaw-session-discussion", SessionDiscussionPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-discussion": SessionDiscussionPanel;
  }
}
