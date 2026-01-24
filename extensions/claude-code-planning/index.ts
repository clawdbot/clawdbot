/**
 * Claude Code Planning Plugin
 *
 * AI-to-AI orchestration for Claude Code sessions.
 * Provides tools for project context management and session spawning.
 *
 * Phase 1: Core plugin without Telegram integration.
 */

import { configSchema, parseConfig, type ClaudeCodePlanningConfig } from "./src/config.js";
import { setConfig } from "./src/context/resolver.js";
import { setStalenessDays, setLogger as setExplorerLogger } from "./src/context/explorer.js";
import { setLogger as setManagerLogger } from "./src/session/manager.js";
import { setLogger as setToolLogger } from "./src/tools/claude-code-start-tool.js";
import { createProjectContextTool } from "./src/tools/project-context-tool.js";
import { createClaudeCodeStartTool } from "./src/tools/claude-code-start-tool.js";

/**
 * Plugin API interface (minimal subset for type safety).
 */
interface PluginApi {
  pluginConfig: unknown;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug(msg: string): void;
  };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      args: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

/**
 * Claude Code Planning Plugin definition.
 */
const claudeCodePlanningPlugin = {
  id: "claude-code-planning",
  name: "Claude Code Planning",
  description: "AI-to-AI orchestration for Claude Code sessions",
  configSchema,

  register(api: PluginApi) {
    const config = parseConfig(api.pluginConfig);

    // Set configuration for modules
    setConfig(config);

    // Set staleness threshold
    if (config.stalenessDays) {
      setStalenessDays(config.stalenessDays);
    }

    // Create plugin-scoped logger
    const createLogger = (subsystem: string) => ({
      info: (msg: string) => api.logger.info(`[${subsystem}] ${msg}`),
      warn: (msg: string) => api.logger.warn(`[${subsystem}] ${msg}`),
      error: (msg: string) => api.logger.error(`[${subsystem}] ${msg}`),
      debug: (msg: string) => api.logger.debug(`[${subsystem}] ${msg}`),
    });

    // Set loggers for all modules
    setExplorerLogger(createLogger("claude-code/context"));
    setManagerLogger(createLogger("claude-code/session"));
    setToolLogger(createLogger("claude-code/tool"));

    // Register project_context tool
    api.registerTool(createProjectContextTool());

    // Register claude_code_start tool
    api.registerTool(
      createClaudeCodeStartTool({
        defaultPermissionMode: config.permissionMode,
        defaultModel: config.model as "opus" | "sonnet" | "haiku" | undefined,
      }),
    );

    api.logger.info("Claude Code Planning plugin registered");
    api.logger.info(`  - Projects base: ${config.projectsBase}`);
    api.logger.info(`  - Project dirs: ${(config.projectDirs || []).join(", ")}`);
    api.logger.info(`  - Staleness: ${config.stalenessDays} days`);
    api.logger.info(`  - Permission mode: ${config.permissionMode}`);
    if (config.model) {
      api.logger.info(`  - Default model: ${config.model}`);
    }
  },
};

export default claudeCodePlanningPlugin;

// Re-export types and utilities for external use
export type { ClaudeCodePlanningConfig } from "./src/config.js";
export type {
  ProjectContext,
  SessionState,
  SessionEvent,
  ClaudeCodeSessionParams,
} from "./src/types.js";
export { createProjectContextTool } from "./src/tools/project-context-tool.js";
export { createClaudeCodeStartTool } from "./src/tools/claude-code-start-tool.js";
export {
  startSession,
  cancelSession,
  getSession,
  getSessionByToken,
  getSessionState,
  listSessions,
} from "./src/session/manager.js";
export {
  resolveProject,
  getGitBranch,
  listKnownProjects,
} from "./src/context/resolver.js";
export {
  exploreProject,
  loadProjectContext,
  loadOrExploreProject,
  formatContextForPrompt,
} from "./src/context/explorer.js";
