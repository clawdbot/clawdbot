/**
 * Project Context Tool
 *
 * Allows agents to load, explore, and update project context
 * for Claude Code planning and session guidance.
 */

import { Type, type Static } from "@sinclair/typebox";
import {
  exploreProject,
  formatContextForPrompt,
  hasProjectContext,
  isContextStale,
  listProjectsWithContext,
  loadOrExploreProject,
  loadProjectContext,
  updateProjectContext,
} from "../context/explorer.js";
import { resolveProject } from "../context/resolver.js";
import type { ProjectContext } from "../types.js";

/**
 * Tool schema using TypeBox.
 */
export const ProjectContextToolSchema = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("load"),
      Type.Literal("explore"),
      Type.Literal("update"),
      Type.Literal("list"),
      Type.Literal("format"),
    ]),
  ),
  project: Type.Optional(Type.String({ description: "Project name" })),
  path: Type.Optional(Type.String({ description: "Absolute path to project" })),
  forceRefresh: Type.Optional(Type.Boolean({ description: "Force re-exploration" })),
  // For update action
  preferences: Type.Optional(
    Type.Array(Type.String(), { description: "User preferences to add" }),
  ),
  sessionSummary: Type.Optional(
    Type.Object({
      task: Type.String(),
      outcome: Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("failed"),
      ]),
      notes: Type.Optional(Type.String()),
    }),
  ),
});

export type ProjectContextToolParams = Static<typeof ProjectContextToolSchema>;

/**
 * Helper to read string param.
 */
function readStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * JSON result helper.
 */
function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

/**
 * Try to find project path from aliases or common locations.
 */
function findProjectPath(projectName: string): string | undefined {
  // Try to resolve as a project name
  const resolved = resolveProject(projectName);
  if (resolved) {
    return resolved.workingDir;
  }
  return undefined;
}

/**
 * Create a summary of context for tool response (avoid sending full claudeMd).
 */
function summarizeContext(context: ProjectContext): object {
  return {
    name: context.name,
    path: context.path,
    type: context.type,
    packageManager: context.packageManager,
    testFramework: context.testFramework,
    buildTool: context.buildTool,
    structureCount: Object.keys(context.structure).length,
    conventionsCount: context.conventions.length,
    preferencesCount: context.preferences.length,
    hasClaudeMd: !!context.claudeMd,
    hasAgentsMd: !!context.agentsMd,
    lastExplored: context.lastExplored,
    isStale: isContextStale(context),
  };
}

/**
 * Create the project_context tool.
 */
export function createProjectContextTool() {
  return {
    name: "project_context",
    label: "Project Context",
    description: `Load, explore, or update project context for Claude Code planning.

Actions:
- load: Load existing context for a project (returns cached or explores if missing/stale)
- explore: Force re-exploration of a project (refreshes cached context)
- update: Add preferences or session summaries to existing context
- list: List all projects with cached context
- format: Format context as markdown for prompt inclusion

Use this before starting a Claude Code session to understand the project.`,
    parameters: ProjectContextToolSchema,
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action") || "load";
      const project = readStringParam(params, "project");
      const projectPath = readStringParam(params, "path");
      const forceRefresh = params.forceRefresh === true;

      // Handle list action
      if (action === "list") {
        const projects = listProjectsWithContext();
        if (projects.length === 0) {
          return jsonResult({
            status: "ok",
            projects: [],
            message: "No projects with cached context found.",
          });
        }

        // Load summary for each project
        const summaries = projects.map((name) => {
          const ctx = loadProjectContext(name);
          return {
            name,
            type: ctx?.type || "unknown",
            path: ctx?.path || "unknown",
            lastExplored: ctx?.lastExplored || "unknown",
            isStale: ctx ? isContextStale(ctx) : true,
          };
        });

        return jsonResult({
          status: "ok",
          projects: summaries,
        });
      }

      // All other actions require project or path
      if (!project && !projectPath) {
        return jsonResult({
          status: "error",
          error: "Either 'project' name or 'path' is required for this action.",
        });
      }

      const resolvedProject = project || undefined;
      const resolvedPath = projectPath || (project ? findProjectPath(project) : undefined);

      if (!resolvedPath) {
        return jsonResult({
          status: "error",
          error: `Could not resolve path for project: ${project}. Provide explicit 'path' parameter.`,
        });
      }

      // Handle explore action
      if (action === "explore") {
        try {
          const context = exploreProject(resolvedPath, resolvedProject);
          return jsonResult({
            status: "ok",
            action: "explored",
            context: summarizeContext(context),
            formatted: formatContextForPrompt(context),
          });
        } catch (err) {
          return jsonResult({
            status: "error",
            error: `Failed to explore project: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Handle load action
      if (action === "load") {
        try {
          const result = loadOrExploreProject(resolvedPath, resolvedProject, forceRefresh);
          return jsonResult({
            status: "ok",
            action: result.isNew ? "explored" : result.wasStale ? "refreshed" : "loaded",
            context: summarizeContext(result.context),
            formatted: formatContextForPrompt(result.context),
          });
        } catch (err) {
          return jsonResult({
            status: "error",
            error: `Failed to load project context: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Handle format action
      if (action === "format") {
        const context = loadProjectContext(resolvedProject || "");
        if (!context) {
          return jsonResult({
            status: "error",
            error: `No context found for project: ${resolvedProject}. Use 'load' or 'explore' first.`,
          });
        }
        return jsonResult({
          status: "ok",
          formatted: formatContextForPrompt(context),
        });
      }

      // Handle update action
      if (action === "update") {
        const projectName = resolvedProject;
        if (!projectName) {
          return jsonResult({
            status: "error",
            error: "Project name required for update action.",
          });
        }

        if (!hasProjectContext(projectName)) {
          return jsonResult({
            status: "error",
            error: `No existing context for project: ${projectName}. Use 'load' or 'explore' first.`,
          });
        }

        const preferences = Array.isArray(params.preferences)
          ? (params.preferences as string[])
          : undefined;

        const sessionSummary = params.sessionSummary as
          | { task: string; outcome: "completed" | "partial" | "failed"; notes?: string }
          | undefined;

        const recentSessions = sessionSummary
          ? [{ date: new Date().toISOString(), ...sessionSummary }]
          : undefined;

        const updated = updateProjectContext(projectName, {
          preferences,
          recentSessions,
        });

        if (!updated) {
          return jsonResult({
            status: "error",
            error: `Failed to update context for: ${projectName}`,
          });
        }

        return jsonResult({
          status: "ok",
          action: "updated",
          context: summarizeContext(updated),
        });
      }

      return jsonResult({
        status: "error",
        error: `Unknown action: ${action}`,
      });
    },
  };
}
