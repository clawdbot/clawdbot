import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { MAX_HUMAN_MENTIONS, updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import "../../../styles/chat/reply-preview.css";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import {
  paneDomId,
  scrollActiveMenuOptionIntoView,
  syncComposerMenuScroll,
} from "./chat-composer-dom.ts";

export type HumanMentionDirectory = {
  client: GatewayBrowserClient;
  ownerKey: string;
  params: UsersMentionableParams;
};

export type HumanMentionMenuHost = {
  paneId: string;
  getDraft: () => string;
  getMentions: () => readonly HumanMention[];
  getTextarea: () => HTMLTextAreaElement | null;
  commitDraft: (value: string, mentions: readonly HumanMention[]) => void;
};

type MentionTarget = { start: number; end: number; query: string };
type MentionSearch =
  | { kind: "loading" }
  | { kind: "ready"; result: UsersMentionableResult }
  | { kind: "error" };

function findMentionTarget(value: string, caret: number): MentionTarget | null {
  if (value.trimStart().startsWith("/")) {
    return null;
  }
  const beforeCaret = value.slice(0, caret);
  const line = beforeCaret.slice(beforeCaret.lastIndexOf("\n") + 1);
  // Code and quoted examples are text, never people-picker invocations.
  if (
    /^\s*>/u.test(line) ||
    (beforeCaret.match(/```/gu)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/gu)?.length ?? 0) % 2 !== 0
  ) {
    return null;
  }
  const match = /(?:^|[\s([{])@([\p{L}\p{N}\p{M}_.-]{0,64})$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  let end = caret;
  while (end < value.length && /[\p{L}\p{N}\p{M}_.-]/u.test(value[end] ?? "")) {
    end += 1;
  }
  return { start, end, query };
}

/** One bounded suggestion lifecycle shared by existing- and new-session composers. */
export class HumanMentionMenu {
  private directory?: HumanMentionDirectory;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private target: MentionTarget | null = null;
  private search: MentionSearch | null = null;
  private index = 0;

  get open(): boolean {
    return this.target !== null;
  }

  syncDirectory(directory: HumanMentionDirectory | undefined) {
    // Results are query snapshots: unrelated session/presence traffic must not cancel typing.
    // Owner changes fence them here; admission rechecks current recipient visibility.
    if (
      this.directory?.client === directory?.client &&
      this.directory?.ownerKey === directory?.ownerKey &&
      JSON.stringify(this.directory?.params) === JSON.stringify(directory?.params)
    ) {
      return;
    }
    this.close();
    this.directory = directory;
  }

  close() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.target = null;
    this.search = null;
    this.index = 0;
  }

  dispose() {
    this.close();
    this.directory = undefined;
  }

  update(value: string, caret: number, requestUpdate: () => void, typedAtSign = false) {
    const target = this.directory ? findMentionTarget(value, caret) : null;
    if (!target || (!this.open && !typedAtSign)) {
      if (this.open) {
        this.close();
        requestUpdate();
      }
      return;
    }
    if (this.target?.start === target.start && this.target.query === target.query) {
      return;
    }
    this.close();
    this.target = target;
    this.search = { kind: "loading" };
    const directory = this.directory;
    if (!directory) {
      return;
    }
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void directory.client
        .request<UsersMentionableResult>("users.mentionable", {
          ...directory.params,
          query: target.query,
        })
        .then(
          (result) => {
            if (generation === this.generation) {
              this.search = { kind: "ready", result };
              requestUpdate();
            }
          },
          () => {
            if (generation === this.generation) {
              this.search = { kind: "error" };
              requestUpdate();
            }
          },
        );
    }, 150);
    requestUpdate();
  }

  activeId(paneId: string): string | null {
    return this.search?.kind === "ready" && this.search.result.users[this.index]
      ? paneDomId(paneId, `mention-option-${this.index}`)
      : null;
  }

  activeLabel(): string {
    return this.search?.kind === "ready"
      ? (this.search.result.users[this.index]?.displayName ?? "")
      : "";
  }

  handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return false;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      requestUpdate();
      return true;
    }
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      return false;
    }
    event.preventDefault();
    const users = this.search?.kind === "ready" ? this.search.result.users : [];
    if (users.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        this.index =
          (this.index + (event.key === "ArrowDown" ? 1 : users.length - 1)) % users.length;
        requestUpdate();
        scrollActiveMenuOptionIntoView(this.activeId(host.paneId));
      } else {
        this.select(users[this.index]!, host, requestUpdate);
      }
    }
    return true;
  }

  private select(
    person: UsersMentionableResult["users"][number],
    host: HumanMentionMenuHost,
    requestUpdate: () => void,
  ) {
    const textarea = host.getTextarea();
    const current = textarea?.value ?? host.getDraft();
    const target = findMentionTarget(current, textarea?.selectionStart ?? current.length);
    if (!target || host.getMentions().length >= MAX_HUMAN_MENTIONS) {
      return;
    }
    const label = `@${person.displayName}`;
    const replacement = `${label} `;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    const mentions = [
      ...updateHumanMentions(current, next, host.getMentions(), {
        value: current,
        start: target.start,
        end: target.end,
        inputType: "insertReplacementText",
      }),
      { profileId: person.profileId, start: target.start, end: target.start + label.length },
    ].toSorted((a, b) => a.start - b.start);
    host.commitDraft(next, mentions);
    this.close();
    requestUpdate();
    queueMicrotask(() => {
      const currentTextarea = host.getTextarea();
      currentTextarea?.focus({ preventScroll: true });
      currentTextarea?.setSelectionRange(
        target.start + replacement.length,
        target.start + replacement.length,
      );
    });
  }

  render(host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open) {
      return nothing;
    }
    const result = this.search?.kind === "ready" ? this.search.result : undefined;
    const limited = host.getMentions().length >= MAX_HUMAN_MENTIONS;
    const message = limited
      ? t("chat.mentions.limit")
      : this.search?.kind === "error"
        ? t("chat.mentions.unavailable")
        : this.search?.kind === "loading"
          ? t("chat.mentions.loading")
          : !result?.users.length
            ? t("chat.mentions.empty")
            : null;
    return html`<div
      id=${paneDomId(host.paneId, "mention-menu-listbox")}
      class="slash-menu mention-menu"
      role="listbox"
      aria-label=${t("chat.mentions.menu")}
    >
      <div class="slash-menu__scroll" ${ref(syncComposerMenuScroll)}>
        <div class="slash-menu-group">
          <div class="slash-menu-group__label" role="status">
            ${message ?? t("chat.mentions.menu")}
          </div>
          ${message
            ? nothing
            : result?.users.map(
                (person, index) => html`<div
                  id=${paneDomId(host.paneId, `mention-option-${index}`)}
                  class="slash-menu-item ${index === this.index ? "slash-menu-item--active" : ""}"
                  role="option"
                  aria-selected=${index === this.index}
                  @mousedown=${(event: MouseEvent) => event.preventDefault()}
                  @click=${() => this.select(person, host, requestUpdate)}
                  @mouseenter=${() => {
                    this.index = index;
                    requestUpdate();
                  }}
                >
                  <span class="slash-menu-icon" aria-hidden="true"
                    >${renderChatAuthorAvatar({
                      id: person.profileId,
                      name: person.displayName,
                      identity: { type: "profile", id: person.profileId },
                      profileAvatarUrl: person.avatarUrl,
                    })}</span
                  >
                  <span class="slash-menu-copy">
                    <span class="slash-menu-name">${person.displayName}</span>
                    <span class="slash-menu-desc"
                      >${person.online ? t("chat.mentions.online") : t("chat.mentions.offline")} ·
                      ${person.profileId.slice(-8)}</span
                    >
                  </span>
                </div>`,
              )}
          ${result?.truncated
            ? html`<div class="slash-menu-group__label">${t("chat.mentions.truncated")}</div>`
            : nothing}
        </div>
      </div>
    </div>`;
  }
}

export function renderSelectedHumanMentions(
  text: string,
  mentions: readonly HumanMention[] | undefined,
  onRemove: () => void,
) {
  if (!mentions?.length) {
    return nothing;
  }
  const names = mentions.map((mention) => text.slice(mention.start, mention.end)).join(", ");
  return html`<div class="chat-reply-preview" role="status">
    <span class="chat-reply-preview__icon" aria-hidden="true">${icons.users}</span>
    <span class="chat-reply-preview__text">${t("chat.mentions.selected", { names })}</span>
    <button
      type="button"
      class="chat-reply-preview__dismiss"
      aria-label=${t("chat.mentions.remove")}
      @click=${onRemove}
    >
      ${icons.x}
    </button>
  </div>`;
}
