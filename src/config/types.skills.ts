/**
 * Skill-related config types for discovery, installation, limits, and per-skill overrides.
 * Secret-bearing skill options use SecretInput so config redaction and secret refs stay consistent.
 */
import type { SecretInput } from "./types.secrets.js";

/** Per-skill runtime override keyed by skill name or source-specific skill key. */
export type SkillConfig = {
  /** Disable a discovered skill without removing it from disk. */
  enabled?: boolean;
  /** Optional secret made available to the skill runtime through skill env handling. */
  apiKey?: SecretInput;
  /** Plain environment overrides applied when the skill runs. */
  env?: Record<string, string>;
  /** Skill-specific structured config consumed by the skill runtime. */
  config?: Record<string, unknown>;
};

/** Discovery and watcher settings for skill sources. */
export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /**
   * Real target directories that skill symlinks may resolve into even when they
   * sit outside the configured source root.
   */
  allowSymlinkTargets?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
};

/** Skill installation preferences and upload policy. */
export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Allow gateway clients to install zip archives staged through skills.upload.*. */
  allowUploadedArchives?: boolean;
};

/** Limits that bound skill discovery and model-facing prompt expansion. */
export type SkillsLimitsConfig = {
  /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */
  maxCandidatesPerRoot?: number;
  /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
  maxSkillsLoadedPerSource?: number;
  /** Max number of skills to include in the model-facing skills prompt. */
  maxSkillsInPrompt?: number;
  /** Max characters for the model-facing skills prompt block (approx). */
  maxSkillsPromptChars?: number;
  /** Max size (bytes) allowed for a SKILL.md file to be considered. */
  maxSkillFileBytes?: number;
};

/** Autonomous and approval settings for generated skill proposals. */
export type SkillsWorkshopConfig = {
  /** Autonomous Skill Workshop behavior controlled separately from user-prompted proposals. */
  autonomous?: {
    /** Allow agents to create pending proposals from durable conversation signals. */
    enabled?: boolean;
  };
  /** Allow Skill Workshop apply to write through trusted skill symlink targets. */
  allowSymlinkTargetWrites?: boolean;
  /** Whether proposal lifecycle actions need explicit approval. */
  approvalPolicy?: "pending" | "auto";
  /** Maximum pending/quarantined proposals retained per workspace. */
  maxPending?: number;
  /** Maximum generated skill proposal size in bytes. */
  maxSkillBytes?: number;
};

/** Top-level skills config block in openclaw config. */
export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */
  allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  workshop?: SkillsWorkshopConfig;
  entries?: Record<string, SkillConfig>;
};
