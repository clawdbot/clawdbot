import { Command } from "commander";
import { registerBrowserCli } from "../browser-cli.js";
import { registerConfigCli } from "../config-cli.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";
import { registerAgentCommands } from "./register.agent.js";
import { registerConfigureCommand } from "./register.configure.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";
import { registerMessageCommands } from "./register.message.js";
import { registerOnboardCommand } from "./register.onboard.js";
import { registerSetupCommand } from "./register.setup.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";
import { registerSubCliCommands } from "./register.subclis.js";

export function buildProgram() {
  const program = new Command();
  const ctx = createProgramContext();

  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  registerSetupCommand(program);
  registerOnboardCommand(program);
  registerConfigureCommand(program);
  registerConfigCli(program);
  registerMaintenanceCommands(program);
  registerMessageCommands(program, ctx);
  registerAgentCommands(program, {
    agentChannelOptions: ctx.agentChannelOptions,
  });
  registerSubCliCommands(program);
  registerStatusHealthSessionsCommands(program);
  registerBrowserCli(program);

  return program;
}
