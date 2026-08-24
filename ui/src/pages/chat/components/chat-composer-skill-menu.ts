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

type SkillDraftToken = {
  command: SlashCommandDef;
  end: number;
  raw: string;
  start: number;
};

type SkillDraftRange = { start: number; end: number; navigationEnd: number };

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

function parseSkillDraftTokens(value: string): SkillDraftToken[] {
  const tokens: SkillDraftToken[] = [];
  const referencePattern = /\$([-a-zA-Z0-9_:]+)/gu;
  for (const match of value.matchAll(referencePattern)) {
    const start = match.index;
    const matchedName = match[1] ?? "";
    const name = matchedName.replace(/:+$/u, "");
    if (start === undefined || isEscapedReference(value, start)) {
      continue;
    }
    const command = getSkillCommandCompletions(name).find((candidate) => candidate.name === name);
    if (!command) {
      continue;
    }
    const raw = `$${name}`;
    tokens.push({ command, end: start + raw.length, raw, start });
  }
  return tokens;
}

function skillDraftRanges(value: string): SkillDraftRange[] {
  const ranges: SkillDraftRange[] = [];
  for (const match of value.matchAll(/\$([-a-zA-Z0-9_:]+)/gu)) {
    const start = match.index;
    const name = (match[1] ?? "").replace(/:+$/u, "");
    if (start === undefined || isEscapedReference(value, start)) {
      continue;
    }
    if (getSkillCommandCompletions(name).some((candidate) => candidate.name === name)) {
      const end = start + name.length + 1;
      ranges.push({ start, end, navigationEnd: /\s/u.test(value[end] ?? "") ? end + 1 : end });
    }
  }
  return ranges;
}

export function normalizeSkillTokenSelection(target: HTMLTextAreaElement): boolean {
  const { selectionStart, selectionEnd } = target;
  let nextStart = selectionStart;
  let nextEnd = selectionEnd;
  for (const range of skillDraftRanges(target.value)) {
    if (
      selectionStart === selectionEnd &&
      selectionStart > range.start &&
      selectionStart < range.navigationEnd
    ) {
      const fromStart = selectionStart - range.start;
      const fromEnd = range.navigationEnd - selectionStart;
      nextStart = fromStart < fromEnd ? range.start : range.navigationEnd;
      nextEnd = nextStart;
      break;
    }
    if (selectionStart > range.start && selectionStart < range.end) {
      nextStart = range.start;
    }
    if (selectionEnd > range.start && selectionEnd < range.end) {
      nextEnd = range.end;
    }
  }
  if (nextStart === selectionStart && nextEnd === selectionEnd) {
    return false;
  }
  target.setSelectionRange(nextStart, nextEnd, target.selectionDirection);
  return true;
}

export function handleSkillTokenKeydown(event: KeyboardEvent): boolean {
  if (
    !["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) {
    return false;
  }
  if (event.shiftKey) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return false;
    }
    const direction = target.selectionDirection;
    const caret = direction === "backward" ? target.selectionStart : target.selectionEnd;
    const anchor = direction === "backward" ? target.selectionEnd : target.selectionStart;
    for (const range of skillDraftRanges(target.value)) {
      const nextCaret =
        event.key === "ArrowLeft" && caret > range.start && caret <= range.end
          ? range.start
          : event.key === "ArrowRight" && caret >= range.start && caret < range.end
            ? range.end
            : null;
      if (nextCaret === null) {
        continue;
      }
      event.preventDefault();
      target.setSelectionRange(
        Math.min(anchor, nextCaret),
        Math.max(anchor, nextCaret),
        nextCaret < anchor ? "backward" : "forward",
      );
      return true;
    }
    return false;
  }
  if (target.selectionStart !== target.selectionEnd) {
    return false;
  }
  const caret = target.selectionStart;
  for (const range of skillDraftRanges(target.value)) {
    const deletesBackward = event.key === "Backspace" && caret === range.end;
    const deletesForward = event.key === "Delete" && caret === range.start;
    if (deletesBackward || deletesForward) {
      event.preventDefault();
      target.setRangeText("", range.start, range.end, "end");
      // Reuse the composer's input owner so the controlled draft, picker, and
      // token overlay observe the atomic replacement together.
      target.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: deletesBackward ? "deleteContentBackward" : "deleteContentForward",
        }),
      );
      return true;
    }
    const movesLeft =
      event.key === "ArrowLeft" && caret > range.start && caret <= range.navigationEnd;
    const movesRight =
      event.key === "ArrowRight" && caret >= range.start && caret < range.navigationEnd;
    if (movesLeft || movesRight) {
      event.preventDefault();
      const nextCaret = movesLeft ? range.start : range.navigationEnd;
      target.setSelectionRange(nextCaret, nextCaret);
      return true;
    }
  }
  return false;
}

export function renderSkillDraftOverlay(
  value: string,
  direction: "ltr" | "rtl",
): TemplateResult | typeof nothing {
  const tokens = parseSkillDraftTokens(value);
  if (tokens.length === 0) {
    return nothing;
  }
  const content: Array<string | TemplateResult> = [];
  let cursor = 0;
  for (const token of tokens) {
    content.push(
      value.slice(cursor, token.start),
      html`<span class="agent-chat__skill-token" data-raw=${token.raw}
        ><span class="agent-chat__skill-token-icon">${icons.pencilSparkles}</span
        >${getSkillDisplayName(token.command)}</span
      >`,
    );
    cursor = token.end;
  }
  content.push(value.slice(cursor));
  // Template whitespace changes the mirrored draft's line breaks. Keep text
  // segments adjacent to inline tokens so only presented content drives layout.
  // oxfmt-ignore
  return html`<div
    class="agent-chat__composer-draft-overlay"
    aria-hidden="true"
    dir=${direction}
  >${content}</div>`;
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
        ${state.skillCommandRefreshPending || state.skillMenuItems.length === 0
          ? html`<div class="slash-menu-group">
              <div class="slash-menu-group__label">${t("chat.skills.loading")}</div>
            </div>`
          : html`<div class="slash-menu-group">
              <div class="slash-menu-group__label">${t("chat.skills.label")}</div>
              ${state.skillMenuItems.map(
                (command, index) => html`
                  <div
                    id=${skillOptionId(host.paneId, command)}
                    class="slash-menu-item ${index === state.skillMenuIndex
                      ? "slash-menu-item--active"
                      : ""}"
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
            </div>`}
      </div>
    </div>
  `;
}
