import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionDiscussionInfo,
  SessionDiscussionState,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { renderPanelEmptyState } from "../../../components/panel-empty-state.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { buildWidgetThemeMessage, postWidgetTheme } from "../../../lib/widget-theme.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

type SessionDiscussionInfoLoader = (sessionKey: string) => Promise<SessionDiscussionInfo>;
type SessionDiscussionOpener = (sessionKey: string) => Promise<SessionDiscussionInfo>;
type SessionDiscussionStateListener = (
  sessionKey: string,
  discussionState: SessionDiscussionState,
  openUrl: string | null,
) => void;

type SessionDiscussionTaskResult = {
  sessionKey: string;
  info: SessionDiscussionInfo;
};

type OpeningDiscussion = {
  sessionKey: string;
  loader: SessionDiscussionInfoLoader;
  opener: SessionDiscussionOpener | null;
  sourceGeneration: number;
  canOpen: boolean;
};

export type SessionDiscussionPanelConfig = {
  sessionKey: string;
  canOpen: boolean;
  openUrl: string | null;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange: SessionDiscussionStateListener;
};

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
  const url = new URL(resolved);
  if (url.origin === window.location.origin) {
    return null;
  }
  if (
    url.searchParams.get("openclawHostTheme") !== "1" ||
    !/^\/embed\/(?:channel|thread)\/[^/]+\/[^/]+\/?$/u.test(url.pathname)
  ) {
    // Provider-issued and signed discussion URLs are opaque. Only ClickClack's
    // documented embed routes support the first-paint theme query contract.
    return url.href;
  }
  // The initial URL protects the first paint; hostOrigin binds subsequent
  // full-palette messages to this exact Control UI parent.
  url.searchParams.set(
    "theme",
    document.documentElement.dataset.themeMode === "light" ? "light" : "dark",
  );
  url.searchParams.set("hostOrigin", window.location.origin);
  const themeTokens = buildWidgetThemeMessage().tokens;
  if (Object.keys(themeTokens).length > 0) {
    url.searchParams.set("themeTokens", JSON.stringify(themeTokens));
  }
  return url.href;
}

class SessionDiscussionPanel extends OpenClawLightDomElement {
  @property() sessionKey = "";
  @property({ attribute: false }) loadInfo: SessionDiscussionInfoLoader | null = null;
  @property({ attribute: false }) openDiscussion: SessionDiscussionOpener | null = null;
  @property({ attribute: false }) onStateChange: SessionDiscussionStateListener | null = null;
  @property({ type: Boolean }) canOpen = true;
  @property({ type: Number }) sourceGeneration = 0;

  @state() private openingDiscussion: OpeningDiscussion | null = null;
  private themeObserver: MutationObserver | null = null;

  private readonly discussionTask = new Task(this, {
    args: () =>
      [
        this.sessionKey.trim(),
        this.loadInfo,
        this.openDiscussion,
        this.sourceGeneration,
        this.canOpen,
      ] as const,
    task: async ([sessionKey, loader, opener, _sourceGeneration, canOpen], { signal }) => {
      if (!loader || !sessionKey) {
        return null;
      }
      const loaded = await loader(sessionKey);
      signal.throwIfAborted();
      const opening = {
        sessionKey,
        loader,
        opener,
        sourceGeneration: _sourceGeneration,
        canOpen,
      };
      if (!this.isOpeningCurrent(opening)) {
        return initialState;
      }
      let info = loaded;
      if (loaded.state === "available" && canOpen && opener) {
        this.openingDiscussion = opening;
        this.publish(sessionKey, loaded);
        if (!this.isOpeningCurrent(opening)) {
          return initialState;
        }
        info = (await opener(sessionKey)) ?? loaded;
      }
      signal.throwIfAborted();
      if (!this.isOpeningCurrent(opening)) {
        return initialState;
      }
      return { sessionKey, info } satisfies SessionDiscussionTaskResult;
    },
    onComplete: (result) => {
      this.openingDiscussion = null;
      if (result) {
        this.publish(result.sessionKey, result.info);
      }
    },
    onError: () => {
      this.openingDiscussion = null;
    },
  });

  private isOpeningCurrent(opening: OpeningDiscussion): boolean {
    return (
      opening.sessionKey === this.sessionKey.trim() &&
      opening.loader === this.loadInfo &&
      opening.opener === this.openDiscussion &&
      opening.sourceGeneration === this.sourceGeneration &&
      opening.canOpen === this.canOpen
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof MutationObserver === "undefined") {
      return;
    }
    this.themeObserver = new MutationObserver(() => this.postDiscussionTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode", "data-color-vision", "style"],
    });
  }

  override disconnectedCallback(): void {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    super.disconnectedCallback();
  }

  private readonly handleDiscussionFrameLoad = (event: Event): void => {
    const frame = event.currentTarget;
    if (frame instanceof HTMLIFrameElement) {
      this.postDiscussionTheme(frame);
    }
  };

  private postDiscussionTheme(
    frame = this.querySelector<HTMLIFrameElement>(".session-discussion__frame"),
  ): void {
    if (!frame?.isConnected) {
      return;
    }
    postWidgetTheme(frame, new URL(frame.src).origin);
  }

  // requestKey is the key the request was issued for; the sessionKey property
  // may already name the next session while an old result resolves. Task only
  // calls onComplete for the latest args, so stale results never publish.
  private publish(requestKey: string, info: SessionDiscussionInfo): void {
    if (requestKey !== this.sessionKey.trim()) {
      return;
    }
    this.onStateChange?.(requestKey, info.state, resolveDiscussionUrl(info.openUrl));
  }

  // The iframe sandbox must include allow-same-origin: without it the frame
  // gets an opaque origin, the discussion app's session cookie is never sent,
  // and the embed is stuck on its sign-in card.
  private renderOpen(info: SessionDiscussionInfo): TemplateResult {
    const embedUrl = resolveDiscussionEmbedUrl(info.embedUrl);
    const openUrl = resolveDiscussionUrl(info.openUrl);
    return html`
      <div class="session-discussion__open">
        ${embedUrl
          ? html`
              <iframe
                class="session-discussion__frame"
                src=${embedUrl}
                title=${t("chat.sessionDiscussion.frameTitle")}
                sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
                @load=${this.handleDiscussionFrameLoad}
              ></iframe>
            `
          : renderPanelEmptyState({
              icon: icons.messageSquare,
              heading: t("chat.sidePanel.discussion"),
              description: t("chat.sessionDiscussion.unavailable"),
              action: openUrl
                ? html`<a class="session-link" href=${openUrl} target="_blank" rel="noopener">
                    ${t("chat.sessionDiscussion.openExternal")}
                  </a>`
                : nothing,
            })}
      </div>
    `;
  }

  override render() {
    if (this.discussionTask.status === TaskStatus.ERROR) {
      const error = this.discussionTask.error;
      return html`<div class="session-discussion__empty">
        <div class="callout danger">${formatUiError(error)}</div>
      </div>`;
    }
    const value = this.discussionTask.value;
    if (
      this.discussionTask.status === TaskStatus.PENDING &&
      this.openingDiscussion &&
      this.isOpeningCurrent(this.openingDiscussion)
    ) {
      return html`<div class="session-discussion__empty">
        ${t("chat.sessionDiscussion.opening")}
      </div>`;
    }
    if (this.discussionTask.status !== TaskStatus.COMPLETE || !value) {
      return html`<div class="session-discussion__empty">
        ${t("chat.sessionDiscussion.loading")}
      </div>`;
    }
    const { info } = value;
    if (info.state === "none") {
      return nothing;
    }
    if (info.state === "available") {
      return this.canOpen
        ? html`<div class="session-discussion__empty">${t("chat.sessionDiscussion.opening")}</div>`
        : renderPanelEmptyState({
            icon: icons.messageSquare,
            heading: t("chat.sidePanel.discussion"),
            description: t("chat.sessionDiscussion.requiresWriteAccess"),
          });
    }
    return this.renderOpen(info);
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
