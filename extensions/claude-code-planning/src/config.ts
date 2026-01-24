/**
 * Configuration Schema for Claude Code Planning Plugin
 *
 * Defines configurable options for project context and session management.
 */

import { Type, type Static } from "@sinclair/typebox";

/**
 * Plugin configuration schema using TypeBox.
 */
export const ClaudeCodePlanningConfigSchema = Type.Object({
  /** Enable the plugin (default: true) */
  enabled: Type.Boolean({ default: true }),

  /** Base directory for storing cached project contexts */
  projectsBase: Type.Optional(
    Type.String({
      description: "Base directory for storing cached project contexts",
      default: "~/clawd/projects",
    }),
  ),

  /** Directories to search when resolving project names (in order) */
  projectDirs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Directories to search when resolving project names",
      default: ["~/Documents/agent", "~/Projects", "~/code"],
    }),
  ),

  /** Explicit project name to path mappings */
  projects: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Explicit project name to path mappings",
    }),
  ),

  /** How many days before cached context is considered stale */
  stalenessDays: Type.Optional(
    Type.Number({
      description: "Days before context is considered stale",
      default: 7,
      minimum: 1,
    }),
  ),

  /** Default permission mode for Claude Code sessions */
  permissionMode: Type.Optional(
    Type.Union(
      [
        Type.Literal("default"),
        Type.Literal("acceptEdits"),
        Type.Literal("bypassPermissions"),
      ],
      {
        description: "Default permission mode for Claude Code sessions",
        default: "default",
      },
    ),
  ),

  /** Default model for Claude Code sessions */
  model: Type.Optional(
    Type.String({
      description: "Default model for Claude Code sessions (opus, sonnet, haiku)",
    }),
  ),
});

export type ClaudeCodePlanningConfig = Static<typeof ClaudeCodePlanningConfigSchema>;

/**
 * Parse and validate plugin configuration.
 */
export function parseConfig(value: unknown): ClaudeCodePlanningConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    projectsBase:
      typeof raw.projectsBase === "string" ? raw.projectsBase : "~/clawd/projects",
    projectDirs: Array.isArray(raw.projectDirs)
      ? (raw.projectDirs as string[])
      : ["~/Documents/agent", "~/Projects", "~/code"],
    projects:
      raw.projects && typeof raw.projects === "object"
        ? (raw.projects as Record<string, string>)
        : undefined,
    stalenessDays:
      typeof raw.stalenessDays === "number" && raw.stalenessDays > 0
        ? raw.stalenessDays
        : 7,
    permissionMode:
      raw.permissionMode === "default" ||
      raw.permissionMode === "acceptEdits" ||
      raw.permissionMode === "bypassPermissions"
        ? raw.permissionMode
        : "default",
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

/**
 * Config schema with parse method and UI hints for settings UI.
 */
export const configSchema = {
  parse: parseConfig,
  uiHints: {
    projectsBase: {
      label: "Projects Context Base",
      placeholder: "~/clawd/projects",
      help: "Where to store cached project contexts",
    },
    projectDirs: {
      label: "Project Directories",
      help: "Directories to search when resolving project names (in order)",
    },
    projects: {
      label: "Project Aliases",
      help: "Explicit project name to path mappings",
      advanced: true,
    },
    stalenessDays: {
      label: "Context Staleness (days)",
      placeholder: "7",
      help: "How long before cached context needs refresh",
    },
    permissionMode: {
      label: "Default Permission Mode",
      help: "Permission mode for Claude Code sessions",
      advanced: true,
    },
    model: {
      label: "Default Model",
      help: "Default model for Claude Code sessions (opus, sonnet, haiku)",
      advanced: true,
    },
  },
};
