// Loads command handlers behind a runtime boundary for the command dispatcher.
import { handleAcpCommand } from "./commands-acp.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleBtwCommand } from "./commands-btw.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import { handleContextCommand } from "./commands-context-command.js";
import { handleDiagnosticsCommand } from "./commands-diagnostics.js";
import { handleGoalCommand } from "./commands-goal.js";
import {
  handleCommandsListCommand,
  handleExportTrajectoryCommand,
  handleExportSessionCommand,
  handleHelpCommand,
  handleSkillCommandUsage,
  handleStatusCommand,
  handleToolsCommand,
} from "./commands-info.js";
import { handleLearnCommand } from "./commands-learn.js";
import { handleLoginCommand } from "./commands-login.js";
import { handleLoopCommand } from "./commands-loop.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { handleModelsCommand } from "./commands-models.js";
import { handleNameCommand } from "./commands-name.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleFastCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleSessionCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSteerCommand } from "./commands-steer.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleSystemAgentCommand } from "./commands-system-agent.js";
import { handleTasksCommand } from "./commands-tasks.js";
import { handleTtsCommands } from "./commands-tts.js";
import type { CommandHandler } from "./commands-types.js";
import { handleWhoamiCommand } from "./commands-whoami.js";

export function loadCommandHandlers(): CommandHandler[] {
  return [
    // Plugin text commands must win before built-in auth routing handles /login.
    handlePluginCommand,
    handleLoginCommand,
    handleBtwCommand,
    handleBashCommand,
    handleActivationCommand,
    handleSendPolicyCommand,
    handleFastCommand,
    handleUsageCommand,
    handleSessionCommand,
    handleRestartCommand,
    handleTtsCommands,
    handleHelpCommand,
    handleCommandsListCommand,
    // Keep deterministic /skill usage before broader tool/status fallthrough.
    handleSkillCommandUsage,
    handleToolsCommand,
    handleStatusCommand,
    handleGoalCommand,
    handleLearnCommand,
    handleLoopCommand,
    handleNameCommand,
    handleDiagnosticsCommand,
    handleTasksCommand,
    handleSteerCommand,
    handleAllowlistCommand,
    handleApproveCommand,
    handleContextCommand,
    handleExportSessionCommand,
    handleExportTrajectoryCommand,
    handleWhoamiCommand,
    handleSystemAgentCommand,
    handleSubagentsCommand,
    handleAcpCommand,
    handleMcpCommand,
    handlePluginsCommand,
    handleConfigCommand,
    handleDebugCommand,
    handleModelsCommand,
    handleStopCommand,
    handleCompactCommand,
    handleAbortTrigger,
  ];
}
