// Fast help renderer for setup/onboard/configure without loading full CLI startup.
import { Command } from "commander";
import { VERSION } from "../version.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import type { ProgramContext } from "./program/context.js";
import { configureProgramHelp } from "./program/help.js";

type SetupOnboardConfigureHelpCommand = "setup" | "onboard" | "configure";

const SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS = new Set<SetupOnboardConfigureHelpCommand>([
  "setup",
  "onboard",
  "configure",
]);

function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

function resolveSetupOnboardConfigureHelpCommand(
  argv: string[],
): SetupOnboardConfigureHelpCommand | null {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.commandPath.length !== 1 || !invocation.hasHelpOrVersion) {
    return null;
  }
  const command = invocation.commandPath[0];
  return SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS.has(command as SetupOnboardConfigureHelpCommand)
    ? (command as SetupOnboardConfigureHelpCommand)
    : null;
}

function createHelpContext(): ProgramContext {
  return {
    programVersion: VERSION,
    channelOptions: [],
    messageChannelOptions: "",
    agentChannelOptions: "last",
  };
}

async function registerHelpCommand(
  program: Command,
  command: SetupOnboardConfigureHelpCommand,
): Promise<void> {
  if (command === "setup") {
    const { registerSetupCommand } = await import("./program/register.setup.js");
    registerSetupCommand(program);
    return;
  }
  if (command === "onboard") {
    const { registerOnboardCommand } = await import("./program/register.onboard.js");
    registerOnboardCommand(program);
    return;
  }
  const { registerConfigureCommand } = await import("./program/register.configure.js");
  registerConfigureCommand(program);
}

export async function tryOutputSetupOnboardConfigureHelp(argv: string[]): Promise<boolean> {
  // Register only the requested command so help stays quick and avoids config/plugin startup.
  const command = resolveSetupOnboardConfigureHelpCommand(argv);
  if (!command) {
    return false;
  }

  const program = new Command();
  program.enablePositionalOptions();
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });
  configureProgramHelp(program, createHelpContext());
  await registerHelpCommand(program, command);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}
