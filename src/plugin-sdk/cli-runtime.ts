// Public CLI/output helpers for plugins that share terminal-facing command behavior.

export * from "../cli/command-format.js";
export { inheritOptionFromParent } from "../cli/command-options.js";
export { runCommandWithRuntime } from "../cli/cli-utils.js";
export { formatHelpExamples } from "../cli/help-format.js";
export {
  registerCommandGroups,
  type CommandGroupEntry,
  type CommandGroupPlaceholder,
} from "../cli/program/register-command-groups.js";
export * from "../cli/parse-duration.js";
export { resolveCliArgvInvocation, type CliArgvInvocation } from "../cli/argv-invocation.js";
export { shouldEagerRegisterSubcommands } from "../cli/command-registration-policy.js";
export * from "../cli/wait.js";
export { note } from "../terminal/note.js";
export { stylePromptTitle } from "../terminal/prompt-style.js";
export { theme } from "../terminal/theme.js";
export * from "../version.js";
