import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ChatSendShortcut } from "../../../app/settings.ts";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  SLASH_COMMANDS,
  executesInlineImmediately,
  findInlineSlashCompletion,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type InlineSlashCompletion,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import {
  paneDomId,
  scrollActiveMenuOptionIntoView,
  syncComposerMenuScroll,
} from "./chat-composer-dom.ts";
import {
  beginInlineFreeformSlashArguments,
  commitInlineSlashSelection,
  findDirectInlineSlashArgumentInvocation,
  hasActiveInlineSlashArgumentPrefix,
  removeInlineSlashSelection,
} from "./chat-composer-inline-slash.ts";
import { getSlashArgOptionId, getSlashCommandOptionId } from "./chat-composer-slash-menu-dom.ts";

export type SlashMenuState = {
  slashCommandDispatchConnected: boolean;
  slashMenuOpen: boolean;
  slashMenuItems: SlashCommandDef[];
  slashMenuIndex: number;
  slashMenuMode: "command" | "args" | "freeform-args";
  slashMenuCommand: SlashCommandDef | null;
  slashMenuArgItems: string[];
  slashMenuCompletion: InlineSlashCompletion | null;
  slashCommandRefreshPending: boolean;
};

export type SlashMenuHost = {
  paneId: string;
  getDraft: () => string;
  commitDraft: (next: string) => void;
  getTextarea: () => HTMLTextAreaElement | null;
  resolveArgOptions: (command: SlashCommandDef) => string[];
  runCommand: () => void;
  canRunInlineCommand: () => boolean;
  runInlineCommand?: (command: string) => void;
  refreshCommands?: () => void | Promise<void>;
  commandFilter?: (command: SlashCommandDef) => boolean;
  activateComposerMode?: (command: SlashCommandDef) => boolean;
};

export function createSlashMenuState(): SlashMenuState {
  return {
    slashCommandDispatchConnected: false,
    slashMenuOpen: false,
    slashMenuItems: [],
    slashMenuIndex: 0,
    slashMenuMode: "command",
    slashMenuCommand: null,
    slashMenuArgItems: [],
    slashMenuCompletion: null,
    slashCommandRefreshPending: false,
  };
}

export function resetSlashMenuState(state: SlashMenuState): void {
  state.slashMenuOpen = false;
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  state.slashMenuItems = [];
  state.slashMenuCompletion = null;
}

function hasVisibleSlashMenuState(state: SlashMenuState): boolean {
  return (
    state.slashMenuOpen ||
    state.slashMenuMode !== "command" ||
    state.slashMenuCommand !== null ||
    state.slashMenuArgItems.length > 0 ||
    state.slashMenuItems.length > 0
  );
}

function closeSlashMenuIfNeeded(state: SlashMenuState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  resetSlashMenuState(state);
  requestUpdate();
}

function requestSlashCommandRefresh(
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): void {
  if (!host.refreshCommands || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = host.refreshCommands();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh)
    .catch(() => undefined)
    .finally(() => {
      state.slashCommandRefreshPending = false;
      const nextValue = host.getDraft();
      if (state.slashMenuMode === "freeform-args" && state.slashMenuCompletion?.inline) {
        updateSlashMenu(nextValue, state, host, requestUpdate, { skipSlashIntent: true });
        return;
      }
      if (state.slashMenuMode === "args" && state.slashMenuCompletion?.inline) {
        return;
      }
      const caret = host.getTextarea()?.selectionStart ?? nextValue.length;
      if (!findInlineSlashCompletion(nextValue, caret)) {
        closeSlashMenuIfNeeded(state, requestUpdate);
        return;
      }
      updateSlashMenu(nextValue, state, host, requestUpdate, { skipSlashIntent: true });
    });
}

export function updateSlashMenu(
  value: string,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
  opts: { skipSlashIntent?: boolean } = {},
): void {
  if (
    state.slashMenuMode === "freeform-args" &&
    state.slashMenuCompletion?.inline &&
    state.slashMenuCommand
  ) {
    const caret = host.getTextarea()?.selectionStart ?? value.length;
    const completion = state.slashMenuCompletion;
    if (hasActiveInlineSlashArgumentPrefix(value, caret, completion, state.slashMenuCommand.name)) {
      state.slashMenuCompletion.end = caret;
      requestUpdate();
      return;
    }
    resetSlashMenuState(state);
  }

  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(state, host, requestUpdate);
    }
    const cmdName = argMatch[1]?.toLowerCase();
    const argFilter = argMatch[2]?.toLowerCase();
    if (cmdName === undefined || argFilter === undefined) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    const cmd = SLASH_COMMANDS.find(
      (entry) => entry.name === cmdName && (host.commandFilter?.(entry) ?? true),
    );
    const argOptions = cmd ? host.resolveArgOptions(cmd) : [];
    if (cmd && argOptions.length > 0) {
      const filtered = argFilter
        ? argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : argOptions;
      if (filtered.length > 0) {
        state.slashMenuMode = "args";
        state.slashMenuCommand = cmd;
        state.slashMenuArgItems = filtered;
        state.slashMenuOpen = true;
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
        state.slashMenuCompletion = null;
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }

  const caret = host.getTextarea()?.selectionStart ?? value.length;
  const completion = findInlineSlashCompletion(value, caret);
  if (!completion) {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  if (!opts.skipSlashIntent) {
    requestSlashCommandRefresh(state, host, requestUpdate);
  }
  const items = getSlashCommandCompletions(completion.query, {
    showAll: true,
    inlineOnly: completion.inline,
    allowImmediateInlineCommands: host.canRunInlineCommand() && !completion.skillOnly,
  }).filter((command) => host.commandFilter?.(command) ?? true);
  state.slashMenuCompletion = completion;
  state.slashMenuItems = [
    ...items.filter((command) => command.source !== "skill"),
    ...items.filter((command) => command.source === "skill"),
  ];
  state.slashMenuOpen = items.length > 0;
  state.slashMenuIndex = 0;
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  requestUpdate();
}

function beginInlineSlashArguments(
  cmd: SlashCommandDef,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): boolean {
  if (
    !state.slashMenuCompletion?.inline ||
    cmd.source === "skill" ||
    !cmd.args ||
    !host.canRunInlineCommand() ||
    !host.runInlineCommand
  ) {
    return false;
  }
  state.slashMenuCommand = cmd;
  state.slashMenuIndex = 0;
  state.slashMenuItems = [];
  const argOptions = host.resolveArgOptions(cmd);
  if (argOptions.length > 0) {
    state.slashMenuMode = "args";
    state.slashMenuArgItems = argOptions;
    state.slashMenuOpen = true;
    requestUpdate();
    return true;
  }
  if (!beginInlineFreeformSlashArguments(cmd.name, state, host)) {
    return false;
  }
  state.slashMenuMode = "freeform-args";
  state.slashMenuArgItems = [];
  state.slashMenuOpen = false;
  requestUpdate();
  return true;
}

function selectSlashCommand(
  cmd: SlashCommandDef,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): void {
  if (host.activateComposerMode?.(cmd)) {
    return;
  }
  if (cmd.source !== "skill" && !host.canRunInlineCommand() && state.slashMenuCompletion?.inline) {
    return;
  }
  const inlineReplacement = cmd.source === "skill" ? `$${cmd.name}` : `/${cmd.name}`;
  if (beginInlineSlashArguments(cmd, state, host, requestUpdate)) {
    return;
  }
  if (
    state.slashMenuCompletion?.inline &&
    executesInlineImmediately(cmd) &&
    host.canRunInlineCommand() &&
    host.runInlineCommand &&
    removeInlineSlashSelection(state, host)
  ) {
    resetSlashMenuState(state);
    requestUpdate();
    host.runInlineCommand(`/${cmd.name}`);
    return;
  }
  if (commitInlineSlashSelection(inlineReplacement, state, host)) {
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }

  const argOptions = host.resolveArgOptions(cmd);
  if (argOptions.length > 0) {
    host.commitDraft(`/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  if (cmd.executeLocal && !cmd.args) {
    resetSlashMenuState(state);
    host.commitDraft(`/${cmd.name}`);
    host.runCommand();
  } else {
    host.commitDraft(`/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): void {
  const inlineReplacement = cmd.source === "skill" ? `$${cmd.name}` : `/${cmd.name}`;
  if (beginInlineSlashArguments(cmd, state, host, requestUpdate)) {
    return;
  }
  if (commitInlineSlashSelection(inlineReplacement, state, host)) {
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  const argOptions = host.resolveArgOptions(cmd);
  if (argOptions.length > 0) {
    host.commitDraft(`/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  host.commitDraft(cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  resetSlashMenuState(state);
  requestUpdate();
}

function selectSlashArg(
  arg: string,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
  run: boolean,
): void {
  const command = state.slashMenuCommand;
  if (command?.source !== "skill" && !host.canRunInlineCommand()) {
    return;
  }
  const cmdName = command?.name ?? "";
  if (
    run &&
    state.slashMenuCompletion?.inline &&
    command &&
    executesInlineImmediately(command) &&
    host.canRunInlineCommand() &&
    host.runInlineCommand &&
    removeInlineSlashSelection(state, host)
  ) {
    resetSlashMenuState(state);
    requestUpdate();
    host.runInlineCommand(`/${cmdName} ${arg}`);
    return;
  }
  if (
    state.slashMenuCompletion?.inline &&
    (!run || !command || !executesInlineImmediately(command)) &&
    commitInlineSlashSelection(`/${cmdName} ${arg}`, state, host)
  ) {
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  resetSlashMenuState(state);
  host.commitDraft(`/${cmdName} ${arg}`);
  if (run) {
    host.runCommand();
  }
  requestUpdate();
}

function submitInlineSlashArgument(
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): boolean {
  const command = state.slashMenuCommand;
  const completion = state.slashMenuCompletion;
  if (
    state.slashMenuMode !== "freeform-args" ||
    !completion?.inline ||
    !command ||
    !executesInlineImmediately(command) ||
    !host.canRunInlineCommand() ||
    !host.runInlineCommand
  ) {
    return false;
  }
  const current = host.getTextarea()?.value ?? host.getDraft();
  const argumentStart = completion.argumentStart ?? completion.start + `/${command.name} `.length;
  const args = current.slice(argumentStart, completion.end).trim();
  if (!removeInlineSlashSelection(state, host)) {
    return false;
  }
  resetSlashMenuState(state);
  requestUpdate();
  host.runInlineCommand(`/${command.name}${args ? ` ${args}` : ""}`);
  return true;
}

function beginDirectInlineSlashArgument(state: SlashMenuState, host: SlashMenuHost): boolean {
  if (!host.canRunInlineCommand() || !host.runInlineCommand) {
    return false;
  }
  const current = host.getTextarea()?.value ?? host.getDraft();
  const caret = host.getTextarea()?.selectionStart ?? current.length;
  const invocation = findDirectInlineSlashArgumentInvocation(current, caret);
  if (!invocation) {
    return false;
  }
  state.slashMenuMode = "freeform-args";
  state.slashMenuCommand = invocation.command;
  state.slashMenuCompletion = invocation.completion;
  return true;
}

export function handleInlineSlashArgKeydown(
  event: KeyboardEvent,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
  sendShortcut: ChatSendShortcut,
): boolean {
  if (event.key === "Escape") {
    if (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) {
      return false;
    }
    event.preventDefault();
    resetSlashMenuState(state);
    requestUpdate();
    return true;
  }
  const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
  if (event.key !== "Enter" || event.shiftKey || !sendShortcutMatches) {
    return false;
  }
  if (
    (state.slashMenuMode !== "freeform-args" || !state.slashMenuCompletion?.inline) &&
    !beginDirectInlineSlashArgument(state, host)
  ) {
    return false;
  }
  if (!state.slashMenuCommand || !executesInlineImmediately(state.slashMenuCommand)) {
    return false;
  }
  event.preventDefault();
  return submitInlineSlashArgument(state, host, requestUpdate);
}

export function handleSlashMenuKeydown(
  event: KeyboardEvent,
  state: SlashMenuState,
  host: SlashMenuHost,
  requestUpdate: () => void,
): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    resetSlashMenuState(state);
    requestUpdate();
    return true;
  }
  const items = state.slashMenuMode === "args" ? state.slashMenuArgItems : state.slashMenuItems;
  if (items.length === 0) {
    return false;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : items.length - 1;
    state.slashMenuIndex = (state.slashMenuIndex + offset) % items.length;
    requestUpdate();
    scrollActiveMenuOptionIntoView(getActiveSlashMenuOptionId(state, host.paneId));
    return true;
  }
  if (event.key !== "Tab" && event.key !== "Enter") {
    return false;
  }
  event.preventDefault();
  if (state.slashMenuMode === "args") {
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    if (arg !== undefined) {
      selectSlashArg(arg, state, host, requestUpdate, event.key === "Enter");
    }
  } else {
    const command = state.slashMenuItems[state.slashMenuIndex];
    if (command) {
      if (event.key === "Enter") {
        selectSlashCommand(command, state, host, requestUpdate);
      } else {
        tabCompleteSlashCommand(command, state, host, requestUpdate);
      }
    }
  }
  return true;
}

function syncComposerMenuScrollEvent(event: Event): void {
  syncComposerMenuScroll(event.currentTarget instanceof Element ? event.currentTarget : undefined);
}

export function isSlashMenuVisible(state: SlashMenuState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuMode === "args") {
    return Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0);
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(state: SlashMenuState, paneId: string): string | null {
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

export function getActiveSlashMenuOptionLabel(state: SlashMenuState): string {
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

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

function renderMatchedName(name: string, query: string): TemplateResult {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0
    ? html`${name}`
    : html`<mark>${name.slice(0, matchLength)}</mark>${name.slice(matchLength)}`;
}

function renderSlashCommandOption(params: {
  cmd: SlashCommandDef;
  index: number;
  query: string;
  requestUpdate: () => void;
  host: SlashMenuHost;
  state: SlashMenuState;
}): TemplateResult {
  const { cmd, index, query, requestUpdate, host, state } = params;
  return html`
    <div
      id=${getSlashCommandOptionId(host.paneId, cmd)}
      class="slash-menu-item ${index === state.slashMenuIndex ? "slash-menu-item--active" : ""}"
      role="option"
      aria-selected=${index === state.slashMenuIndex}
      @mousedown=${(event: MouseEvent) => event.preventDefault()}
      @click=${() => selectSlashCommand(cmd, state, host, requestUpdate)}
      @mouseenter=${() => {
        state.slashMenuIndex = index;
        requestUpdate();
      }}
    >
      <span class="slash-menu-icon"
        >${cmd.source === "skill"
          ? icons.pencilSparkles
          : cmd.icon
            ? renderSlashIcon(cmd.icon)
            : icons.terminal}</span
      >
      <span class="slash-menu-copy">
        <span class="slash-menu-name"
          >/${renderMatchedName(cmd.name, query)}${cmd.args
            ? html`<span class="slash-menu-args"> ${cmd.args}</span>`
            : nothing}</span
        >
        <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
      </span>
    </div>
  `;
}

export function renderSlashMenu(
  state: SlashMenuState,
  host: SlashMenuHost,
  draft: string,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const listboxId = paneDomId(host.paneId, "slash-menu-listbox");
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
        <div
          class="slash-menu__scroll"
          ${ref(syncComposerMenuScroll)}
          @scroll=${syncComposerMenuScrollEvent}
        >
          <div class="slash-menu-group">
            <div class="slash-menu-group__label">
              /${state.slashMenuCommand.name} ${getSlashCommandDescription(state.slashMenuCommand)}
            </div>
            ${state.slashMenuArgItems.map(
              (arg, i) => html`
                <div
                  id=${getSlashArgOptionId(host.paneId, state.slashMenuCommand?.name ?? "", arg)}
                  class="slash-menu-item ${i === state.slashMenuIndex
                    ? "slash-menu-item--active"
                    : ""}"
                  role="option"
                  aria-selected=${i === state.slashMenuIndex}
                  @click=${() => selectSlashArg(arg, state, host, requestUpdate, true)}
                  @mouseenter=${() => {
                    state.slashMenuIndex = i;
                    requestUpdate();
                  }}
                >
                  <span class="slash-menu-icon"
                    >${state.slashMenuCommand?.icon
                      ? renderSlashIcon(state.slashMenuCommand.icon)
                      : icons.terminal}</span
                  >
                  <span class="slash-menu-copy">
                    <span class="slash-menu-name">${arg}</span>
                    <span class="slash-menu-desc">/${state.slashMenuCommand?.name} ${arg}</span>
                  </span>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const query = draft.slice(1);
  const commands = state.slashMenuItems.filter((command) => command.source !== "skill");
  const skills = state.slashMenuItems.filter((command) => command.source === "skill");
  const groups: Array<[SlashCommandCategory, Array<{ command: SlashCommandDef; index: number }>]> =
    [];
  for (const [index, command] of commands.entries()) {
    const category = command.category ?? "session";
    const group =
      draft === "/" ? groups.find(([groupCategory]) => groupCategory === category) : groups.at(-1);
    if (group?.[0] === category) {
      group[1].push({ command, index });
    } else {
      groups.push([category, [{ command, index }]]);
    }
  }

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      <div
        class="slash-menu__scroll"
        ${ref(syncComposerMenuScroll)}
        @scroll=${syncComposerMenuScrollEvent}
      >
        ${groups.map(
          ([category, entries]) => html`<div class="slash-menu-group">
            <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(category)}</div>
            ${entries.map(({ command, index }) =>
              renderSlashCommandOption({
                cmd: command,
                index,
                query,
                requestUpdate,
                host,
                state,
              }),
            )}
          </div>`,
        )}
        ${skills.length > 0
          ? html`<div class="slash-menu-group slash-menu-group--skills">
              <div class="slash-menu-group__label">${t("chat.skills.label")}</div>
              ${skills.map((cmd, index) =>
                renderSlashCommandOption({
                  cmd,
                  index: commands.length + index,
                  query,
                  requestUpdate,
                  host,
                  state,
                }),
              )}
            </div>`
          : nothing}
      </div>
    </div>
  `;
}
