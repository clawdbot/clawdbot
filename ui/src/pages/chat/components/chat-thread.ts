// Public chat transcript renderer and DOM shell.
import { html, nothing, type TemplateResult } from "lit";
import { sessionRefFromPath } from "../../../app-session-route-paths.ts";
import {
  handleMarkdownCodeBlockCopy,
  updateMarkdownCodeBlockOverflow,
} from "../../../components/markdown-code-blocks.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import {
  markdownSessionHref,
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
} from "../../../components/markdown-session-links.ts";
import { t } from "../../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import {
  handleTranscriptContextMenu,
  handleTranscriptPointerUp,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import {
  type ChatTranscriptSession,
  ChatTranscriptController,
} from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import { renderWelcomeState } from "./chat-welcome.ts";

function renderLoadingSkeleton() {
  return html`
    <div class="chat-loading-skeleton" aria-label=${t("chat.thread.loading")}>
      <div class="chat-line assistant">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div
              class="skeleton skeleton-line skeleton-line--medium"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
      <div class="chat-line user" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div class="skeleton skeleton-line skeleton-line--medium"></div>
          </div>
        </div>
      </div>
      <div class="chat-line assistant" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderHistorySentinel(loading: boolean) {
  return html`
    <div class="chat-history-sentinel">
      ${loading
        ? html`
            <div class="chat-history-loading" role="status">
              <span class="session-run-spinner" aria-hidden="true"></span>
              <span>${t("common.loading")}</span>
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderChatThread(
  props: ChatThreadProps,
  transcript: ChatTranscriptController,
): TemplateResult {
  return transcript.renderSession(props.paneId, props.sessionKey, (session) =>
    renderTranscriptShell(props, session),
  );
}

function renderTranscriptShell(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): TemplateResult {
  const projection = projectChatTranscript(props, transcript);
  const historySentinel =
    props.historyLoading === undefined ? nothing : renderHistorySentinel(props.historyLoading);
  const transcriptContents =
    projection.showLoadingSkeleton || projection.isEmpty
      ? html`
          <div class="chat-thread-inner">
            ${historySentinel} ${projection.showLoadingSkeleton ? renderLoadingSkeleton() : nothing}
            ${projection.isEmpty && !projection.searchOpen ? renderWelcomeState(props) : nothing}
            ${projection.isEmpty && projection.searchOpen
              ? html` <div class="agent-chat__empty">${t("chat.thread.noMatches")}</div> `
              : nothing}
          </div>
        `
      : projection.renderRows(historySentinel);
  const handleScroll = (event: Event) => {
    props.onChatScroll?.(event);
    updateMarkdownCodeBlockOverflow(event);
  };
  return html`
    <div
      class="chat-thread ${projection.isDirectThread ? "chat-thread--direct" : ""}"
      role="log"
      aria-live="off"
      aria-relevant="additions"
      tabindex="0"
      @focusin=${(event: FocusEvent) => transcript.handleFocusIn(event)}
      @focusout=${(event: FocusEvent) => transcript.handleFocusOut(event)}
      @scroll=${{ handleEvent: handleScroll, capture: true }}
      @wheel=${props.onHistoryIntent ? { handleEvent: props.onHistoryIntent, passive: true } : null}
      @keydown=${(event: KeyboardEvent) => {
        const target = markdownFileLinkFromKeyboardEvent(event);
        if (target) {
          props.onOpenWorkspaceFile?.(target);
          return;
        }
        const sessionTarget =
          markdownSessionLinkFromKeyboardEvent(event) ??
          (event.key === "Enter"
            ? markdownSessionHref(event, sessionRefFromPath, props.basePath)
            : null);
        if (sessionTarget) {
          event.preventDefault();
          props.onOpenSessionLink?.(sessionTarget);
          return;
        }
        props.onHistoryIntent?.(event);
      }}
      @touchstart=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchmove=${props.onHistoryIntent
        ? { handleEvent: props.onHistoryIntent, passive: true }
        : null}
      @touchend=${props.onHistoryIntent}
      @touchcancel=${props.onHistoryIntent}
      @pointerover=${updateMarkdownCodeBlockOverflow}
      @click=${(event: MouseEvent) => {
        handleMarkdownCodeBlockCopy(event);
        const target = markdownFileLinkFromEvent(event);
        if (target) {
          props.onOpenWorkspaceFile?.(target);
          return;
        }
        const sessionTarget =
          markdownSessionLinkFromEvent(event) ??
          markdownSessionHref(event, sessionRefFromPath, props.basePath);
        if (sessionTarget && shouldHandleNavigationClick(event)) {
          event.preventDefault();
          props.onOpenSessionLink?.(sessionTarget);
        }
      }}
      @contextmenu=${(event: MouseEvent) => handleTranscriptContextMenu(event, props)}
      @pointerup=${(event: PointerEvent) => handleTranscriptPointerUp(event, props)}
    >
      <span
        class="chat-transcript-announcement sr-only"
        role="status"
        aria-live=${props.announceTranscript !== false ? "polite" : "off"}
        aria-atomic="true"
        >${transcript.liveAnnouncementText}</span
      >
      ${transcriptContents}
    </div>
  `;
}
