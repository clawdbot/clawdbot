import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toolIcons } from "../../../components/icons-tools.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";

function renderSystemLine(params: {
  icon?: keyof typeof toolIcons;
  label: string;
  metric?: string;
}) {
  return html`
    <div
      class="chat-divider__rule"
      role="separator"
      aria-label=${params.metric ? `${params.label}, ${params.metric}` : params.label}
    >
      <span class="chat-divider__line"></span>
      <span class="chat-divider__label">
        ${params.icon
          ? html`<span class="chat-divider__icon" aria-hidden="true"
              >${toolIcons[params.icon]}</span
            >`
          : nothing}
        <span class="chat-divider__title">${params.label}</span>
        ${params.metric
          ? html`
              <span class="chat-divider__separator" aria-hidden="true">·</span>
              <span class="chat-divider__metric">${params.metric}</span>
            `
          : nothing}
      </span>
      <span class="chat-divider__line"></span>
    </div>
  `;
}

export function renderChatDivider(
  item: Extract<ChatItem, { kind: "divider" }>,
  onOpenSessionCheckpoints?: () => void | Promise<void>,
) {
  const action =
    item.action?.kind === "session-checkpoints" && onOpenSessionCheckpoints
      ? item.action
      : undefined;
  return html`
    <div class="chat-divider" data-chat-row-key=${item.key} data-ts=${String(item.timestamp)}>
      ${renderSystemLine(item)}
      ${item.description || action
        ? html`
            <div class="chat-divider__details">
              ${item.description
                ? html`<span class="chat-divider__description">${item.description}</span>`
                : nothing}
              ${item.description && action
                ? html`<span class="chat-divider__details-separator" aria-hidden="true">·</span>`
                : nothing}
              ${action
                ? html`
                    <button
                      type="button"
                      class="chat-divider__action"
                      @click=${() => onOpenSessionCheckpoints?.()}
                    >
                      ${action.label}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}

export function renderChatNotice(item: Extract<ChatItem, { kind: "notice" }>) {
  const body = item.text
    ? html`
        <div class="chat-text chat-notice__body" dir=${detectTextDirection(item.text)}>
          ${unsafeHTML(toSanitizedMarkdownHtml(item.text, { codeBlockChrome: "none" }))}
        </div>
      `
    : nothing;
  return html`
    <div
      class="chat-notice ${item.tone === "danger" ? "chat-notice--danger callout danger" : ""}"
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
      role=${item.tone === "danger" ? "alert" : nothing}
    >
      ${item.label ? renderSystemLine({ icon: item.icon, label: item.label }) : nothing}
      ${item.collapsedBody && item.text
        ? html`
            <details class="chat-notice__collapse">
              <summary class="chat-notice__toggle">${t("chat.systemNotice.showContent")}</summary>
              ${body}
            </details>
          `
        : body}
    </div>
  `;
}
