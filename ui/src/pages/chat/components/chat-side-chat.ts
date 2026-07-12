// Floating side-chat panel: multi-turn /btw Q&A overlay pinned to the thread column.
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { buildSideChatFollowUpCommand } from "../../../lib/chat/side-question.ts";
import type { ChatSideResult, ChatSideResultPending } from "../../../lib/chat/side-result.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";

export type SideChatPanelProps = {
  turns: ChatSideResult[];
  pending: ChatSideResultPending | null;
  hidden: boolean;
  /** Archived/non-composable sessions render the transcript without the follow-up input. */
  canFollowUp: boolean;
  /** `question` is the user's typed follow-up for the pending-turn display;
   * `command` embeds prior-turn context and is never parsed back apart.
   * `onSendRejected` fires when the detached send is not accepted. */
  onFollowUp?: (command: string, question: string, onSendRejected?: () => void) => void;
  onClose?: () => void;
  onClear?: () => void;
};

export function isSideChatPanelVisible(
  props: Pick<SideChatPanelProps, "turns" | "pending" | "hidden">,
): boolean {
  return !props.hidden && (props.turns.length > 0 || props.pending != null);
}

// Questions arrive display-ready: chat-send strips composer commands, the
// server echo carries no /btw prefix, and panel follow-ups pass structured
// text. Re-parsing here would corrupt questions that start with a command
// token, so render them verbatim.
function renderSideChatTurn(turn: ChatSideResult): TemplateResult {
  const question = turn.question;
  return html`
    <article class=${`chat-side-chat__turn ${turn.isError ? "chat-side-chat__turn--error" : ""}`}>
      <div class="chat-side-chat__question" dir=${detectTextDirection(question)}>${question}</div>
      <div class="chat-side-chat__answer" dir=${detectTextDirection(turn.text)}>
        ${unsafeHTML(toSanitizedMarkdownHtml(turn.text))}
      </div>
    </article>
  `;
}

function renderSideChatPendingTurn(pending: ChatSideResultPending): TemplateResult {
  const question = pending.question;
  return html`
    <article class="chat-side-chat__turn chat-side-chat__turn--pending">
      <div class="chat-side-chat__question" dir=${detectTextDirection(question)}>${question}</div>
      <div class="chat-side-chat__thinking">${t("chat.sideChat.thinking")}</div>
    </article>
  `;
}

export function renderSideChatPanel(props: SideChatPanelProps): TemplateResult | typeof nothing {
  if (!isSideChatPanelVisible(props)) {
    return nothing;
  }
  const { turns, pending } = props;
  // Error turns carry failure text, not an answer; the newest real turn is
  // the context a follow-up rides on.
  const lastTurn = turns.findLast((turn) => !turn.isError) ?? null;
  // New turns (or a new pending question) pin the scroll position to the
  // bottom; the key guard keeps unrelated re-renders from fighting the user's
  // manual scroll.
  const scrollKey = `${turns.length}:${pending?.runId ?? pending?.ts ?? ""}`;
  const syncScroll = (element: Element | undefined) => {
    if (!(element instanceof HTMLElement) || element.dataset.sideChatScrollKey === scrollKey) {
      return;
    }
    element.dataset.sideChatScrollKey = scrollKey;
    element.scrollTop = element.scrollHeight;
  };
  const submitFollowUp = (input: HTMLInputElement) => {
    const followUp = buildSideChatFollowUpCommand(
      lastTurn ? { question: lastTurn.question, answer: lastTurn.text } : null,
      input.value,
    );
    if (!followUp || !props.onFollowUp) {
      return;
    }
    props.onFollowUp(followUp.command, followUp.question, () => {
      // A rejected detached send must not eat the typed follow-up; restore it
      // unless the user already typed something new.
      if (input.isConnected && !input.value) {
        input.value = followUp.question;
      }
    });
    input.value = "";
  };
  return html`
    <section class="chat-side-chat" role="dialog" aria-label=${t("chat.sideChat.title")}>
      <header class="chat-side-chat__header">
        <div class="chat-side-chat__heading">
          <h2 class="chat-side-chat__title">${t("chat.sideChat.title")}</h2>
          <span class="chat-side-chat__meta">${t("chat.sideChat.notSaved")}</span>
        </div>
        <div class="chat-side-chat__actions">
          <openclaw-tooltip .content=${t("chat.sideChat.clear")}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn"
              type="button"
              aria-label=${t("chat.sideChat.clear")}
              @click=${() => props.onClear?.()}
            >
              ${icons.trash}
            </button>
          </openclaw-tooltip>
          <openclaw-tooltip .content=${t("chat.sideChat.close")}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn"
              type="button"
              aria-label=${t("chat.sideChat.close")}
              @click=${() => props.onClose?.()}
            >
              ${icons.x}
            </button>
          </openclaw-tooltip>
        </div>
      </header>
      <div class="chat-side-chat__scroll" aria-live="polite" ${ref(syncScroll)}>
        ${turns.map(renderSideChatTurn)} ${pending ? renderSideChatPendingTurn(pending) : nothing}
      </div>
      ${props.canFollowUp
        ? html`
            <footer class="chat-side-chat__composer">
              <!-- Disabled while a question is pending: a new /btw would retire
                   the in-flight run and silently drop its answer. -->
              <div class="chat-side-chat__prompt">
                <input
                  class="chat-side-chat__input"
                  type="text"
                  placeholder=${pending ? t("chat.sideChat.thinking") : t("chat.sideChat.followUp")}
                  aria-label=${t("chat.sideChat.followUpLabel")}
                  .disabled=${pending != null}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key !== "Enter" || event.isComposing) {
                      return;
                    }
                    event.preventDefault();
                    submitFollowUp(event.currentTarget as HTMLInputElement);
                  }}
                />
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-side-chat__send"
                  type="button"
                  aria-label=${t("chat.sideChat.sendFollowUp")}
                  .disabled=${pending != null}
                  @click=${(event: MouseEvent) => {
                    const input = (event.currentTarget as HTMLElement)
                      .closest(".chat-side-chat__prompt")
                      ?.querySelector<HTMLInputElement>(".chat-side-chat__input");
                    if (input) {
                      submitFollowUp(input);
                      input.focus();
                    }
                  }}
                >
                  ${icons.cornerDownLeft}
                </button>
              </div>
            </footer>
          `
        : nothing}
    </section>
  `;
}
