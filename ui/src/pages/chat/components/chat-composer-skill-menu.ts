import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  getSkillCommandCompletions,
  getSkillDisplayName,
  getSlashCommandDescription,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import {
  paneDomId,
  scrollActiveMenuOptionIntoView,
  syncComposerMenuScroll,
} from "./chat-composer-dom.ts";

const SKILL_MENTION_CHAR = /[-a-zA-Z0-9_:]/u;

function renderSkillName(name: string, query: string): TemplateResult {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0
    ? html`${name}`
    : html`<mark>${name.slice(0, matchLength)}</mark>${name.slice(matchLength)}`;
}

type SkillMentionTarget = {
  start: number;
  end: number;
  query: string;
};

export type SkillMenuState = {
  skillMenuOpen: boolean;
  skillMenuItems: SlashCommandDef[];
  skillMenuIndex: number;
  skillMenuTarget: SkillMentionTarget | null;
  skillCommandRefreshPending: boolean;
  skillCommandRefreshGeneration: number;
  skillCommandRefreshTargetStart: number | null;
};

export type SkillMenuHost = {
  paneId: string;
  getDraft: () => string;
  commitDraft: (next: string) => void;
  getTextarea: () => HTMLTextAreaElement | null;
  refreshCommands?: () => void | Promise<void>;
};

export function createSkillMenuState(): SkillMenuState {
  return {
    skillMenuOpen: false,
    skillMenuItems: [],
    skillMenuIndex: 0,
    skillMenuTarget: null,
    skillCommandRefreshPending: false,
    skillCommandRefreshGeneration: 0,
    skillCommandRefreshTargetStart: null,
  };
}

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

function hasVisibleSkillMenuState(state: SkillMenuState): boolean {
  return (
    state.skillMenuOpen ||
    state.skillMenuItems.length > 0 ||
    state.skillMenuTarget !== null ||
    state.skillCommandRefreshPending
  );
}

export function resetSkillMenuState(state: SkillMenuState): void {
  state.skillCommandRefreshGeneration += 1;
  state.skillCommandRefreshPending = false;
  state.skillCommandRefreshTargetStart = null;
  state.skillMenuOpen = false;
  state.skillMenuItems = [];
  state.skillMenuIndex = 0;
  state.skillMenuTarget = null;
}

function closeSkillMenuIfNeeded(state: SkillMenuState, requestUpdate: () => void): void {
  if (!hasVisibleSkillMenuState(state)) {
    return;
  }
  resetSkillMenuState(state);
  requestUpdate();
}

function requestSkillCommandRefresh(
  state: SkillMenuState,
  host: SkillMenuHost,
  requestUpdate: () => void,
): void {
  if (!host.refreshCommands || state.skillCommandRefreshPending) {
    return;
  }
  const refresh = host.refreshCommands();
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
      const value = host.getDraft();
      const caret = host.getTextarea()?.selectionStart ?? value.length;
      updateSkillMenu(value, caret, state, host, requestUpdate, { skipRefresh: true });
    });
}

export function updateSkillMenu(
  value: string,
  caret: number,
  state: SkillMenuState,
  host: SkillMenuHost,
  requestUpdate: () => void,
  opts: { skipRefresh?: boolean } = {},
): void {
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
    requestSkillCommandRefresh(state, host, requestUpdate);
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

export function isSkillMenuVisible(state: SkillMenuState): boolean {
  return (
    state.skillMenuOpen && (state.skillMenuItems.length > 0 || state.skillCommandRefreshPending)
  );
}

export function getActiveSkillMenuOptionId(state: SkillMenuState, paneId: string): string | null {
  if (!isSkillMenuVisible(state) || state.skillCommandRefreshPending) {
    return null;
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? skillOptionId(paneId, command) : null;
}

export function getActiveSkillMenuOptionLabel(state: SkillMenuState): string {
  if (state.skillCommandRefreshPending) {
    return "";
  }
  const command = state.skillMenuItems[state.skillMenuIndex];
  return command ? `${getSkillDisplayName(command)} ${getSlashCommandDescription(command)}` : "";
}

function selectSkillMention(
  command: SlashCommandDef,
  state: SkillMenuState,
  host: SkillMenuHost,
  requestUpdate: () => void,
): void {
  if (state.skillCommandRefreshPending) {
    return;
  }
  const textarea = host.getTextarea();
  const current = textarea?.value ?? host.getDraft();
  const currentCaret = textarea?.selectionStart ?? state.skillMenuTarget?.end ?? current.length;
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
  host.commitDraft(next);
  resetSkillMenuState(state);
  requestUpdate();
  queueMicrotask(() => {
    const currentTextarea = host.getTextarea();
    if (!currentTextarea) {
      return;
    }
    currentTextarea.focus({ preventScroll: true });
    currentTextarea.setSelectionRange(nextCaret, nextCaret);
  });
}

export function handleSkillMenuKeydown(
  event: KeyboardEvent,
  state: SkillMenuState,
  host: SkillMenuHost,
  requestUpdate: () => void,
): boolean {
  if (!state.skillMenuOpen) {
    return false;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    resetSkillMenuState(state);
    requestUpdate();
    return true;
  }
  const items = state.skillCommandRefreshPending ? [] : state.skillMenuItems;
  if (items.length === 0) {
    if (["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : items.length - 1;
    state.skillMenuIndex = (state.skillMenuIndex + offset) % items.length;
    requestUpdate();
    scrollActiveMenuOptionIntoView(getActiveSkillMenuOptionId(state, host.paneId));
    return true;
  }
  if (event.key === "Tab" || event.key === "Enter") {
    event.preventDefault();
    const command = items[state.skillMenuIndex];
    if (command) {
      selectSkillMention(command, state, host, requestUpdate);
    }
    return true;
  }
  return false;
}

export function renderSkillMenu(
  state: SkillMenuState,
  host: SkillMenuHost,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  if (!isSkillMenuVisible(state)) {
    return nothing;
  }
  const listboxId = paneDomId(host.paneId, "skill-menu-listbox");
  return html`
    <div
      id=${listboxId}
      class="slash-menu skill-menu"
      role="listbox"
      aria-label=${t("chat.skills.menu")}
    >
      <div
        class="slash-menu__scroll"
        ${ref(syncComposerMenuScroll)}
        @scroll=${(event: Event) =>
          syncComposerMenuScroll(
            event.currentTarget instanceof Element ? event.currentTarget : undefined,
          )}
      >
        ${
          state.skillCommandRefreshPending || state.skillMenuItems.length === 0
            ? html`<div class="slash-menu-group">
                <div class="slash-menu-group__label">${t("chat.skills.loading")}</div>
              </div>`
            : html`<div class="slash-menu-group">
                <div class="slash-menu-group__label">${t("chat.skills.label")}</div>
                ${state.skillMenuItems.map(
                  (command, index) => html`
                    <div
                      id=${skillOptionId(host.paneId, command)}
                      class="slash-menu-item ${
                        index === state.skillMenuIndex ? "slash-menu-item--active" : ""
                      }"
                      role="option"
                      aria-selected=${index === state.skillMenuIndex}
                      @mousedown=${(event: MouseEvent) => event.preventDefault()}
                      @click=${() => selectSkillMention(command, state, host, requestUpdate)}
                      @mouseenter=${() => {
                        state.skillMenuIndex = index;
                        requestUpdate();
                      }}
                    >
                      <span class="slash-menu-icon">${icons.pencilSparkles}</span>
                      <span class="slash-menu-copy">
                        <span class="slash-menu-name"
                          >${renderSkillName(
                            getSkillDisplayName(command),
                            state.skillMenuTarget?.query ?? "",
                          )}</span
                        >
                        <span class="slash-menu-desc">${getSlashCommandDescription(command)}</span>
                      </span>
                    </div>
                  `,
                )}
              </div>`
        }
      </div>
    </div>
  `;
}
