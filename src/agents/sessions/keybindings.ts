/**
 * Application keybinding definitions and user-config migration helpers.
 *
 * Wraps pi-tui keybindings with OpenClaw-specific actions and per-agent overrides.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAgentDir } from "../config.js";

/** OpenClaw-specific key ids added to the shared pi-tui keybinding registry. */
interface AppKeybindings {
  "app.interrupt": true;
  "app.clear": true;
  "app.exit": true;
  "app.suspend": true;
  "app.thinking.cycle": true;
  "app.model.cycleForward": true;
  "app.model.cycleBackward": true;
  "app.model.select": true;
  "app.tools.expand": true;
  "app.thinking.toggle": true;
  "app.session.toggleNamedFilter": true;
  "app.editor.external": true;
  "app.message.followUp": true;
  "app.message.dequeue": true;
  "app.clipboard.pasteImage": true;
  "app.session.new": true;
  "app.session.tree": true;
  "app.session.fork": true;
  "app.session.resume": true;
  "app.tree.foldOrUp": true;
  "app.tree.unfoldOrDown": true;
  "app.tree.editLabel": true;
  "app.tree.toggleLabelTimestamp": true;
  "app.session.togglePath": true;
  "app.session.toggleSort": true;
  "app.session.rename": true;
  "app.session.delete": true;
  "app.session.deleteNoninvasive": true;
  "app.models.save": true;
  "app.models.enableAll": true;
  "app.models.clearAll": true;
  "app.models.toggleProvider": true;
  "app.models.reorderUp": true;
  "app.models.reorderDown": true;
  "app.tree.filter.default": true;
  "app.tree.filter.noTools": true;
  "app.tree.filter.userOnly": true;
  "app.tree.filter.labeledOnly": true;
  "app.tree.filter.all": true;
  "app.tree.filter.cycleForward": true;
  "app.tree.filter.cycleBackward": true;
}

declare module "@earendil-works/pi-tui" {
  interface Keybindings extends AppKeybindings {}
}

/** Complete keybinding definition map consumed by the TUI keybinding manager. */
const KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
  "app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
  "app.suspend": {
    defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
    description: "Suspend to background",
  },
  "app.thinking.cycle": {
    defaultKeys: "shift+tab",
    description: "Cycle thinking level",
  },
  "app.model.cycleForward": {
    defaultKeys: "ctrl+p",
    description: "Cycle to next model",
  },
  "app.model.cycleBackward": {
    defaultKeys: "shift+ctrl+p",
    description: "Cycle to previous model",
  },
  "app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": {
    defaultKeys: "ctrl+t",
    description: "Toggle thinking blocks",
  },
  "app.session.toggleNamedFilter": {
    defaultKeys: "ctrl+n",
    description: "Toggle named session filter",
  },
  "app.editor.external": {
    defaultKeys: "ctrl+g",
    description: "Open external editor",
  },
  "app.message.followUp": {
    defaultKeys: "alt+enter",
    description: "Queue follow-up message",
  },
  "app.message.dequeue": {
    defaultKeys: "alt+up",
    description: "Restore queued messages",
  },
  "app.clipboard.pasteImage": {
    defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
    description: "Paste image from clipboard",
  },
  "app.session.new": { defaultKeys: [], description: "Start a new session" },
  "app.session.tree": { defaultKeys: [], description: "Open session tree" },
  "app.session.fork": { defaultKeys: [], description: "Fork current session" },
  "app.session.resume": { defaultKeys: [], description: "Resume a session" },
  "app.tree.foldOrUp": {
    defaultKeys: ["ctrl+left", "alt+left"],
    description: "Fold tree branch or move up",
  },
  "app.tree.unfoldOrDown": {
    defaultKeys: ["ctrl+right", "alt+right"],
    description: "Unfold tree branch or move down",
  },
  "app.tree.editLabel": {
    defaultKeys: "shift+l",
    description: "Edit tree label",
  },
  "app.tree.toggleLabelTimestamp": {
    defaultKeys: "shift+t",
    description: "Toggle tree label timestamps",
  },
  "app.session.togglePath": {
    defaultKeys: "ctrl+p",
    description: "Toggle session path display",
  },
  "app.session.toggleSort": {
    defaultKeys: "ctrl+s",
    description: "Toggle session sort mode",
  },
  "app.session.rename": {
    defaultKeys: "ctrl+r",
    description: "Rename session",
  },
  "app.session.delete": {
    defaultKeys: "ctrl+d",
    description: "Delete session",
  },
  "app.session.deleteNoninvasive": {
    defaultKeys: "ctrl+backspace",
    description: "Delete session when query is empty",
  },
  "app.models.save": {
    defaultKeys: "ctrl+s",
    description: "Save model selection",
  },
  "app.models.enableAll": {
    defaultKeys: "ctrl+a",
    description: "Enable all models",
  },
  "app.models.clearAll": {
    defaultKeys: "ctrl+x",
    description: "Clear all models",
  },
  "app.models.toggleProvider": {
    defaultKeys: "ctrl+p",
    description: "Toggle all models for provider",
  },
  "app.models.reorderUp": {
    defaultKeys: "alt+up",
    description: "Move model up in order",
  },
  "app.models.reorderDown": {
    defaultKeys: "alt+down",
    description: "Move model down in order",
  },
  "app.tree.filter.default": {
    defaultKeys: "ctrl+d",
    description: "Tree filter: default view",
  },
  "app.tree.filter.noTools": {
    defaultKeys: "ctrl+t",
    description: "Tree filter: hide tool results",
  },
  "app.tree.filter.userOnly": {
    defaultKeys: "ctrl+u",
    description: "Tree filter: user messages only",
  },
  "app.tree.filter.labeledOnly": {
    defaultKeys: "ctrl+l",
    description: "Tree filter: labeled entries only",
  },
  "app.tree.filter.all": {
    defaultKeys: "ctrl+a",
    description: "Tree filter: show all entries",
  },
  "app.tree.filter.cycleForward": {
    defaultKeys: "ctrl+o",
    description: "Tree filter: cycle forward",
  },
  "app.tree.filter.cycleBackward": {
    defaultKeys: "shift+ctrl+o",
    description: "Tree filter: cycle backward",
  },
} as const satisfies KeybindingDefinitions;

const KEYBINDING_NAME_MIGRATIONS = {
  cursorUp: "tui.editor.cursorUp",
  cursorDown: "tui.editor.cursorDown",
  cursorLeft: "tui.editor.cursorLeft",
  cursorRight: "tui.editor.cursorRight",
  cursorWordLeft: "tui.editor.cursorWordLeft",
  cursorWordRight: "tui.editor.cursorWordRight",
  cursorLineStart: "tui.editor.cursorLineStart",
  cursorLineEnd: "tui.editor.cursorLineEnd",
  jumpForward: "tui.editor.jumpForward",
  jumpBackward: "tui.editor.jumpBackward",
  pageUp: "tui.editor.pageUp",
  pageDown: "tui.editor.pageDown",
  deleteCharBackward: "tui.editor.deleteCharBackward",
  deleteCharForward: "tui.editor.deleteCharForward",
  deleteWordBackward: "tui.editor.deleteWordBackward",
  deleteWordForward: "tui.editor.deleteWordForward",
  deleteToLineStart: "tui.editor.deleteToLineStart",
  deleteToLineEnd: "tui.editor.deleteToLineEnd",
  yank: "tui.editor.yank",
  yankPop: "tui.editor.yankPop",
  undo: "tui.editor.undo",
  newLine: "tui.input.newLine",
  submit: "tui.input.submit",
  tab: "tui.input.tab",
  copy: "tui.input.copy",
  selectUp: "tui.select.up",
  selectDown: "tui.select.down",
  selectPageUp: "tui.select.pageUp",
  selectPageDown: "tui.select.pageDown",
  selectConfirm: "tui.select.confirm",
  selectCancel: "tui.select.cancel",
  interrupt: "app.interrupt",
  clear: "app.clear",
  exit: "app.exit",
  suspend: "app.suspend",
  cycleThinkingLevel: "app.thinking.cycle",
  cycleModelForward: "app.model.cycleForward",
  cycleModelBackward: "app.model.cycleBackward",
  selectModel: "app.model.select",
  expandTools: "app.tools.expand",
  toggleThinking: "app.thinking.toggle",
  toggleSessionNamedFilter: "app.session.toggleNamedFilter",
  externalEditor: "app.editor.external",
  followUp: "app.message.followUp",
  dequeue: "app.message.dequeue",
  pasteImage: "app.clipboard.pasteImage",
  newSession: "app.session.new",
  tree: "app.session.tree",
  fork: "app.session.fork",
  resume: "app.session.resume",
  treeFoldOrUp: "app.tree.foldOrUp",
  treeUnfoldOrDown: "app.tree.unfoldOrDown",
  treeEditLabel: "app.tree.editLabel",
  treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
  toggleSessionPath: "app.session.togglePath",
  toggleSessionSort: "app.session.toggleSort",
  renameSession: "app.session.rename",
  deleteSession: "app.session.delete",
  deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, Keybinding>;

function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
  return key in KEYBINDING_NAME_MIGRATIONS;
}

function toKeybindingsConfig(value: unknown): KeybindingsConfig {
  if (!isRecord(value)) {
    return {};
  }

  const config: KeybindingsConfig = {};
  for (const [key, binding] of Object.entries(value)) {
    if (typeof binding === "string") {
      config[key] = binding as KeyId;
      continue;
    }
    if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
      config[key] = binding as KeyId[];
    }
  }
  return config;
}

/** Migrates legacy keybinding names and orders known entries ahead of unknown extras. */
function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
  config: Record<string, unknown>;
  migrated: boolean;
} {
  const config: Record<string, unknown> = {};
  let migrated = false;

  for (const [key, value] of Object.entries(rawConfig)) {
    const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
    if (nextKey !== key) {
      migrated = true;
    }
    if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
      // New names win when both legacy and migrated keys are present.
      migrated = true;
      continue;
    }
    config[nextKey] = value;
  }

  return { config: orderKeybindingsConfig(config), migrated };
}

function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const keybinding of Object.keys(KEYBINDINGS)) {
    if (Object.hasOwn(config, keybinding)) {
      ordered[keybinding] = config[keybinding];
    }
  }

  const extras = Object.keys(config)
    .filter((key) => !Object.hasOwn(ordered, key))
    .toSorted();
  for (const key of extras) {
    ordered[key] = config[key];
  }

  return ordered;
}

function loadRawConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Keybinding manager that loads OpenClaw defaults plus optional user overrides. */
export class KeybindingsManager extends TuiKeybindingsManager {
  private configPath: string | undefined;

  constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
    super(KEYBINDINGS, userBindings);
    this.configPath = configPath;
  }

  /** Creates a manager from the agent keybindings.json file. */
  static create(agentDir: string = getAgentDir()): KeybindingsManager {
    const configPath = join(agentDir, "keybindings.json");
    const userBindings = KeybindingsManager.loadFromFile(configPath);
    return new KeybindingsManager(userBindings, configPath);
  }

  /** Reloads user overrides from disk when this manager was created with a config path. */
  reload(): void {
    if (!this.configPath) {
      return;
    }
    this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
  }

  /** Returns the currently resolved keybinding map after defaults and overrides. */
  getEffectiveConfig(): KeybindingsConfig {
    return this.getResolvedBindings();
  }

  private static loadFromFile(path: string): KeybindingsConfig {
    const rawConfig = loadRawConfig(path);
    if (!rawConfig) {
      return {};
    }
    return toKeybindingsConfig(migrateKeybindingsConfig(rawConfig).config);
  }
}

export type { KeybindingsConfig };
