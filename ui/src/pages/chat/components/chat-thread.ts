// Public chat transcript renderer and DOM shell.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { sessionRefFromPath } from "../../../app-session-route-paths.ts";
import {
  handleMarkdownCodeBlockClick,
  initializeMarkdownCodeBlocks,
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
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "../../../components/markdown-tables.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../../lib/navigation-click.ts";
import { hydrateLinkFavicons } from "../link-favicon-loader.ts";
import {
  handleTranscriptContextMenu,
  handleTranscriptPointerUp,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import {
  ChatTranscriptController,
  type ChatTranscriptSession,
} from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import { renderWelcomeState } from "./chat-welcome.ts";

const markdownTableOwnerRefs = new WeakMap<
  ChatTranscriptSession,
  (element: Element | undefined) => void
>();

function markdownTableOwnerRef(
  transcript: ChatTranscriptSession,
): (element: Element | undefined) => void {
  const current = markdownTableOwnerRefs.get(transcript);
  if (current) {
    return current;
  }
  let owner: HTMLElement | null = null;
  const callback = (element: Element | undefined) => {
    const next = element instanceof HTMLElement ? element : null;
    if (owner && owner !== next) {
      releaseMarkdownTables(owner);
    }
    owner = next;
    if (owner) {
      enhanceMarkdownTables(owner);
    }
  };
  markdownTableOwnerRefs.set(transcript, callback);
  return callback;
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
  // The sentinel is an out-of-flow IntersectionObserver target pinned over the
  // virtualized rows; any content here paints on top of real messages. The
  // floating "Show earlier" pill owns the loading affordance.
  const historySentinel = props.historySentinel
    ? html`<div class="chat-history-sentinel"></div>`
    : nothing;
  const transcriptContents =
    projection.showLoadingSkeleton || projection.isEmpty
      ? html`
          <div class="chat-thread-inner" ${ref(transcript.scrollElementRef)}>
            ${historySentinel}
            ${projection.showLoadingSkeleton
              ? renderPanelLoadingSkeleton("chat", t("chat.thread.loading"))
              : nothing}
            ${projection.isEmpty && !projection.searchOpen ? renderWelcomeState(props) : nothing}
            ${projection.isEmpty && projection.searchOpen
              ? html` <div class="agent-chat__empty">${t("chat.thread.noMatches")}</div> `
              : nothing}
          </div>
        `
      : projection.renderRows(historySentinel);
  return html`
    <div
      class="chat-thread ${projection.isDirectThread ? "chat-thread--direct" : ""}"
      ${ref((element) => {
        if (element instanceof HTMLElement) {
          initializeMarkdownCodeBlocks(element);
          hydrateLinkFavicons(element, props.fetchLinkFavicon);
        }
      })}
      role="log"
      aria-live="off"
      aria-relevant="additions"
      tabindex="0"
      ${ref(markdownTableOwnerRef(transcript))}
      @focusin=${(event: FocusEvent) => transcript.handleFocusIn(event)}
      @focusout=${(event: FocusEvent) => transcript.handleFocusOut(event)}
      @scroll=${props.onChatScroll}
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
      @click=${(event: MouseEvent) => {
        handleMarkdownCodeBlockClick(event);
        handleMarkdownTableInteraction(event);
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
