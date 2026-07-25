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
import { handleDockCommand } from "./commands-dock.js";
import { handleGoalCommand } from "./commands-goal.js";
import { commandHandlerOrder, type CommandHandlerId } from "./commands-handlers.order.js";
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

const commandHandlersById = {
  acp: handleAcpCommand,
  activation: handleActivationCommand,
  allowlist: handleAllowlistCommand,
  approve: handleApproveCommand,
  "abort-trigger": handleAbortTrigger,
  bash: handleBashCommand,
  btw: handleBtwCommand,
  "commands-list": handleCommandsListCommand,
  compact: handleCompactCommand,
  config: handleConfigCommand,
  context: handleContextCommand,
  debug: handleDebugCommand,
  diagnostics: handleDiagnosticsCommand,
  dock: handleDockCommand,
  "export-session": handleExportSessionCommand,
  "export-trajectory": handleExportTrajectoryCommand,
  fast: handleFastCommand,
  goal: handleGoalCommand,
  help: handleHelpCommand,
  learn: handleLearnCommand,
  login: handleLoginCommand,
  mcp: handleMcpCommand,
  models: handleModelsCommand,
  name: handleNameCommand,
  plugin: handlePluginCommand,
  plugins: handlePluginsCommand,
  restart: handleRestartCommand,
  "send-policy": handleSendPolicyCommand,
  session: handleSessionCommand,
  "skill-usage": handleSkillCommandUsage,
  status: handleStatusCommand,
  steer: handleSteerCommand,
  stop: handleStopCommand,
  subagents: handleSubagentsCommand,
  "system-agent": handleSystemAgentCommand,
  tasks: handleTasksCommand,
  tools: handleToolsCommand,
  tts: handleTtsCommands,
  usage: handleUsageCommand,
  whoami: handleWhoamiCommand,
} satisfies Record<CommandHandlerId, CommandHandler>;

export function loadCommandHandlers(): CommandHandler[] {
  return commandHandlerOrder.map((id) => commandHandlersById[id]);
}
