import { handleAcpCommand } from "./commands-acp.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleBtwCommand } from "./commands-btw.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import { handleContextCommand } from "./commands-context-command.js";
import { handleCrestodianCommand } from "./commands-crestodian.js";
import { handleDockCommand } from "./commands-dock.js";
import {
  handleCommandsListCommand,
  handleExportTrajectoryCommand,
  handleExportSessionCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleToolsCommand,
} from "./commands-info.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { handleModelsCommand } from "./commands-models.js";
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
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTasksCommand } from "./commands-tasks.js";
import { handleTtsCommands } from "./commands-tts.js";
import type { CommandHandler } from "./commands-types.js";
import { handleWhoamiCommand } from "./commands-whoami.js";

export function loadCommandHandlers(): CommandHandler[] {
  return [
    handlePluginCommand,
    handleDockCommand,
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
    handleToolsCommand,
    handleStatusCommand,
    handleTasksCommand,
    handleAllowlistCommand,
    handleApproveCommand,
    handleContextCommand,
    handleExportSessionCommand,
    handleExportTrajectoryCommand,
    handleWhoamiCommand,
    handleCrestodianCommand,
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
