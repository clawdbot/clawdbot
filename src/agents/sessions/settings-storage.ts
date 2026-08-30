import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireFileLockSyncWithRetry } from "../../infra/file-lock-sync.js";
import type { Transport } from "../../llm/types.js";
import { CONFIG_DIR_NAME } from "../config.js";

interface CompactionSettings {
  enabled?: boolean; // default: true
  reserveTokens?: number; // default: 16384
  keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
  reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
  skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
  timeoutMs?: number; // SDK/provider request timeout in milliseconds
  maxRetries?: number; // SDK/provider retry attempts
  maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
  enabled?: boolean; // default: true
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
  provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
  showImages?: boolean; // default: true (only relevant if terminal supports images)
  imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
  clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
  showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ImageSettings {
  autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
  blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  max?: number;
}

export interface MarkdownSettings {
  codeBlockIndent?: string; // default: "  "
}

export interface WarningSettings {
  anthropicExtraUsage?: boolean; // default: true
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

export interface Settings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  transport?: TransportSetting; // default: "auto"
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  theme?: string;
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
  quietStartup?: boolean;
  shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
  npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
  collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
  enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
  packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
  extensions?: string[]; // Array of local extension file paths or directories
  skills?: string[]; // Array of local skill file paths or directories
  prompts?: string[]; // Array of local prompt template paths or directories
  themes?: string[]; // Array of local theme file paths or directories
  enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
  doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
  thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
  editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
  autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
  showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
  httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
}

export type SettingsScope = "global" | "project";

export const SETTINGS_SCOPES: SettingsScope[] = ["global", "project"];

export interface SettingsStorage {
  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
  scope: SettingsScope;
  error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
  private paths: Record<SettingsScope, string>;

  constructor(cwd: string, agentDir: string) {
    this.paths = {
      global: join(agentDir, "settings.json"),
      project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
    };
  }

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const path = this.paths[scope];
    const dir = dirname(path);

    let release: (() => void) | undefined;
    try {
      const directoryExists = existsSync(dir);
      if (directoryExists) {
        release = acquireFileLockSyncWithRetry(path);
      }
      // Missing-directory reads stay side-effect free. Concurrent external first creators
      // remain unsupported because they can derive writes before a lock path exists.
      const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
      const next = fn(current);
      if (next !== undefined) {
        if (!directoryExists) {
          mkdirSync(dir, { recursive: true });
          release = acquireFileLockSyncWithRetry(path);
        }
        writeFileSync(path, next, "utf-8");
      }
    } finally {
      release?.();
    }
  }
}

export class InMemorySettingsStorage implements SettingsStorage {
  private values: Record<SettingsScope, string | undefined> = {
    global: undefined,
    project: undefined,
  };

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.values[scope]);
    if (next !== undefined) {
      this.values[scope] = next;
    }
  }
}
