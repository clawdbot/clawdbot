import { html, nothing, type TemplateResult } from "lit";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  SLASH_COMMANDS,
  getHiddenCommandCount,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { exportChatMarkdown } from "../export.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  state.slashMenuItems = [];
  state.slashMenuExpanded = false;
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return (
    state.slashMenuOpen ||
    state.slashMenuMode !== "command" ||
    state.slashMenuCommand !== null ||
    state.slashMenuArgItems.length > 0 ||
    state.slashMenuItems.length > 0 ||
    state.slashMenuExpanded
  );
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

export function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1]?.toLowerCase();
    const argFilter = argMatch[2]?.toLowerCase();
    if (cmdName === undefined || argFilter === undefined) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    const cmd = SLASH_COMMANDS.find((entry) => entry.name === cmdName);
    if (cmd?.argOptions?.length) {
      const filtered = argFilter
        ? cmd.argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : cmd.argOptions;
      if (filtered.length > 0) {
        state.slashMenuMode = "args";
        state.slashMenuCommand = cmd;
        state.slashMenuArgItems = filtered;
        state.slashMenuOpen = true;
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }

  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1] ?? "", {
      showAll: state.slashMenuExpanded,
    });
    state.slashMenuItems = items;
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  requestUpdate();
}

export function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

export function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  if (cmd.argOptions?.length) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = cmd.argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

export function selectSlashArg(
  arg: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  run: boolean,
) {
  const state = getChatComposerState(props.paneId);
  const cmdName = state.slashMenuCommand?.name ?? "";
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  if (run) {
    props.onSend();
  }
  requestUpdate();
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}

function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

export function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuMode === "args") {
    return Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0);
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(paneId, commandName, arg) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

export function scrollActiveSlashMenuOptionIntoView(
  state: ChatComposerState,
  paneId: string,
): void {
  const activeId = getActiveSlashMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const menu = activeOption?.closest<HTMLElement>(".slash-menu");
    if (!activeOption || !menu) {
      return;
    }
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      menu.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      menu.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

export function tokenEstimate(draft: string): string | null {
  if (draft.length < 100) {
    return null;
  }
  return `~${Math.ceil(draft.length / 4)} tokens`;
}

export function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

export function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  if (
    state.slashMenuMode === "args" &&
    state.slashMenuCommand &&
    state.slashMenuArgItems.length > 0
  ) {
    return html`
      <div
        id=${listboxId}
        class="slash-menu"
        role="listbox"
        aria-label=${t("chat.commands.arguments")}
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            /${state.slashMenuCommand.name} ${getSlashCommandDescription(state.slashMenuCommand)}
          </div>
          ${state.slashMenuArgItems.map(
            (arg, i) => html`
              <div
                id=${getSlashArgOptionId(props.paneId, state.slashMenuCommand?.name ?? "", arg)}
                class="slash-menu-item ${i === state.slashMenuIndex
                  ? "slash-menu-item--active"
                  : ""}"
                role="option"
                aria-selected=${i === state.slashMenuIndex}
                @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                @mouseenter=${() => {
                  state.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                ${state.slashMenuCommand?.icon
                  ? html`<span class="slash-menu-icon"
                      >${renderSlashIcon(state.slashMenuCommand.icon)}</span
                    >`
                  : nothing}
                <span class="slash-menu-name">${arg}</span>
                <span class="slash-menu-desc">/${state.slashMenuCommand?.name} ${arg}</span>
              </div>
            `,
          )}
        </div>
        <div class="slash-menu-footer">
          <kbd>↑↓</kbd> ${t("chat.commands.navigate")} <kbd>Tab</kbd> ${t("chat.commands.fill")}
          <kbd>Enter</kbd> ${t("chat.commands.run")} <kbd>Esc</kbd>
          ${t("chat.commands.close")}
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const grouped = new Map<
    SlashCommandCategory,
    Array<{ cmd: SlashCommandDef; globalIdx: number }>
  >();
  for (const [i, cmd] of state.slashMenuItems.entries()) {
    const cat = cmd.category ?? "session";
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push({ cmd, globalIdx: i });
  }

  const sections: TemplateResult[] = [];
  for (const [cat, entries] of grouped) {
    sections.push(html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(cat)}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(props.paneId, cmd)}
              class="slash-menu-item ${globalIdx === state.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === state.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                state.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              ${cmd.icon
                ? html`<span class="slash-menu-icon">${renderSlashIcon(cmd.icon)}</span>`
                : nothing}
              <span class="slash-menu-name">/${cmd.name}</span>
              ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
              ${cmd.argOptions?.length
                ? html`<span class="slash-menu-badge"
                    >${t("chat.commands.optionCount", {
                      count: String(cmd.argOptions.length),
                    })}</span
                  >`
                : cmd.executeLocal && !cmd.args
                  ? html` <span class="slash-menu-badge">${t("chat.commands.instant")}</span> `
                  : nothing}
            </div>
          `,
        )}
      </div>
    `);
  }

  const hiddenCount = state.slashMenuExpanded ? 0 : getHiddenCommandCount();

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      ${sections}
      ${hiddenCount > 0
        ? html`<button
            class="slash-menu-show-more"
            @click=${(event: Event) => {
              event.preventDefault();
              event.stopPropagation();
              state.slashMenuExpanded = true;
              updateSlashMenu(draft, requestUpdate, props);
            }}
          >
            ${hiddenCount === 1
              ? t("chat.commands.showMoreOne")
              : t("chat.commands.showMoreMany", { count: String(hiddenCount) })}
          </button>`
        : nothing}
      <div class="slash-menu-footer">
        <kbd>↑↓</kbd> ${t("chat.commands.navigate")} <kbd>Tab</kbd> ${t("chat.commands.fill")}
        <kbd>Enter</kbd> ${t("chat.commands.select")} <kbd>Esc</kbd>
        ${t("chat.commands.close")}
      </div>
    </div>
  `;
}
