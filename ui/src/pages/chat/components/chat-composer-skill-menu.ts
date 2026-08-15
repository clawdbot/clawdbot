import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  getSkillCommandCompletions,
  getSkillDisplayName,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { paneDomId } from "./chat-composer-slash-menu.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

const SKILL_MENTION_CHAR = /[-a-zA-Z0-9_:]/u;

type SkillMentionTarget = {
  start: number;
  end: number;
  query: string;
};

function isEscapedReference(value: string, dollar: number): boolean {
  let backslashes = 0;
  for (let cursor = dollar - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findSkillMentionTarget(value: string, caret: number): SkillMentionTarget | null {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  let start = safeCaret;
  while (start > 0 && SKILL_MENTION_CHAR.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  if (start === 0 || value[start - 1] !== "$") {
    return null;
  }
  const dollar = start - 1;
  if (isEscapedReference(value, dollar)) {
    return null;
  }
  let end = safeCaret;
  while (end < value.length && SKILL_MENTION_CHAR.test(value[end] ?? "")) {
    end += 1;
  }
  let referenceEnd = end;
  while (referenceEnd > start && value[referenceEnd - 1] === ":") {
    referenceEnd -= 1;
  }
  const query = value.slice(start, referenceEnd);
  if (query.length > 0 && !/[a-z]/u.test(query)) {
    return null;
  }
  return { start: dollar, end: referenceEnd, query };
}

function hasVisibleSkillMenuState(state: ChatComposerState): boolean {
  return (
    state.skillMenuOpen ||
    state.skillMenuItems.length > 0 ||
    state.skillMenuTarget !== null ||
    state.skillCommandRefreshPending
  );
}

export function resetSkillMenuState(state: ChatComposerState): void {
  state.skillCommandRefreshGeneration += 1;
  state.skillCommandRefreshPending = false;
  state.skillCommandRefreshTargetStart = null;
  state.skillMenuOpen = false;
  state.skillMenuItems = [];
  state.skillMenuIndex = 0;
  state.skillMenuTarget = null;
}

function closeSkillMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSkillMenuState(state)) {
    return;
  }
  resetSkillMenuState(state);
  requestUpdate();
}

function requestSkillCommandRefresh(
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue: () => string,
  getCurrentCaret: () => number,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.skillCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  const generation = state.skillCommandRefreshGeneration + 1;
  state.skillCommandRefreshGeneration = generation;
  state.skillCommandRefreshPending = true;
  void Promise.resolve(refresh)
    .catch(() => undefined)
    .finally(() => {
      if (state.skillCommandRefreshGeneration !== generation) {
        return;
      }
      state.skillCommandRefreshPending = false;
      updateSkillMenu(
        getCurrentValue(),
        getCurrentCaret(),
        requestUpdate,
        props,
        { skipRefresh: true },
        getCurrentValue,
        getCurrentCaret,
      );
    });
}

export function updateSkillMenu(
  value: string,
  caret: number,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipRefresh?: boolean } = {},
  getCurrentValue: () => string = () => value,
  getCurrentCaret: () => number = () => caret,
): void {
  const state = getChatComposerState(props.paneId);
  if (value.trimStart().startsWith("/")) {
    closeSkillMenuIfNeeded(state, requestUpdate);
    return;
  }
  const target = findSkillMentionTarget(value, caret);
  if (!target) {
    closeSkillMenuIfNeeded(state, requestUpdate);
    return;
  }
  if (!opts.skipRefresh && state.skillCommandRefreshTargetStart !== target.start) {
    state.skillCommandRefreshTargetStart = target.start;
    requestSkillCommandRefresh(props, requestUpdate, getCurrentValue, getCurrentCaret);
  }
  const items = getSkillCommandCompletions(target.query);
  state.skillMenuTarget = target;
  state.skillMenuItems = items;
  state.skillMenuIndex = Math.min(state.skillMenuIndex, Math.max(0, items.length - 1));
  state.skillMenuOpen = items.length > 0 || state.skillCommandRefreshPending;
  requestUpdate();
}

function skillOptionId(paneId: string, command: SlashCommandDef): string {
  const name = command.name.replace(/[^a-z0-9_-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return paneDomId(paneId, `skill-option-${name || "skill"}`);
}

export function isSkillMenuVisible(state: ChatComposerState): boolean {
  return (
    state.skillMenuOpen && (state.skillMenuItems.length > 0 || state.skillCommandRefreshPending)
  );
}

export function getActiveSkillMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSkillMenuVisible(state) || state.skillCommandRefreshPending) {
    return null;
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? skillOptionId(paneId, command) : null;
}

export function getActiveSkillMenuOptionLabel(state: ChatComposerState): string {
  if (state.skillCommandRefreshPending) {
    return "";
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? `${getSkillDisplayName(command)} ${getSlashCommandDescription(command)}` : "";
}

export function scrollActiveSkillMenuOptionIntoView(
  state: ChatComposerState,
  paneId: string,
): void {
  const activeId = getActiveSkillMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

export function selectSkillMention(
  command: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  if (state.skillCommandRefreshPending) {
    return;
  }
  const current = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
  const currentCaret =
    state.composerTextarea?.selectionStart ?? state.skillMenuTarget?.end ?? current.length;
  const target = findSkillMentionTarget(current, currentCaret);
  if (!target) {
    resetSkillMenuState(state);
    requestUpdate();
    return;
  }
  const suffix = target.end === current.length ? " " : "";
  const replacement = `$${command.name}${suffix}`;
  const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
  const retainedBeforeCaret = Math.max(0, currentCaret - target.end);
  const nextCaret = target.start + replacement.length + retainedBeforeCaret;
  commitComposerDraft(props, next);
  resetSkillMenuState(state);
  requestUpdate();
  queueMicrotask(() => {
    const textarea = state.composerTextarea;
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(nextCaret, nextCaret);
  });
}

export function renderSkillMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  if (!isSkillMenuVisible(state)) {
    return nothing;
  }
  const listboxId = paneDomId(props.paneId, "skill-menu-listbox");
  return html`
    <div
      id=${listboxId}
      class="slash-menu skill-menu"
      role="listbox"
      aria-label=${t("chat.skills.menu")}
    >
      <div class="slash-menu__scroll">
        ${state.skillCommandRefreshPending || state.skillMenuItems.length === 0
          ? html`<div class="slash-menu-group">
              <div class="slash-menu-group__label">${t("chat.skills.loading")}</div>
            </div>`
          : html`<div class="slash-menu-group">
              <div class="slash-menu-group__label">${t("chat.skills.label")}</div>
              ${state.skillMenuItems.map(
                (command, index) => html`
                  <div
                    id=${skillOptionId(props.paneId, command)}
                    class="slash-menu-item ${index === state.skillMenuIndex
                      ? "slash-menu-item--active"
                      : ""}"
                    role="option"
                    aria-selected=${index === state.skillMenuIndex}
                    @mousedown=${(event: MouseEvent) => event.preventDefault()}
                    @click=${() => selectSkillMention(command, props, requestUpdate)}
                    @mouseenter=${() => {
                      state.skillMenuIndex = index;
                      requestUpdate();
                    }}
                  >
                    <span class="slash-menu-leading">
                      <span class="slash-menu-icon">${icons.zap}</span>
                      <span class="slash-menu-name">${getSkillDisplayName(command)}</span>
                    </span>
                    <span class="slash-menu-trailing">
                      <span class="slash-menu-desc">${getSlashCommandDescription(command)}</span>
                    </span>
                  </div>
                `,
              )}
            </div>`}
      </div>
    </div>
  `;
}
