export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
};

/**
 * Controls how skills are injected into the system prompt.
 * - "full": Inject all skill metadata (default, current behavior)
 * - "compact": Inject only skill names and truncated descriptions
 * - "lazy": No upfront injection; skills available via list_skills tool
 */
export type SkillsPromptMode = "full" | "compact" | "lazy";

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  /**
   * Controls how skills are injected into the system prompt.
   * @default "full"
   */
  promptMode?: SkillsPromptMode;
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  entries?: Record<string, SkillConfig>;
};
