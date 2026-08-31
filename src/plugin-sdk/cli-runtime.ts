/**
 * @deprecated Broad public SDK barrel. Prefer focused CLI/runtime subpaths and
 * avoid adding new imports here.
 */

export { formatCliCommand } from "../cli/command-format.js";
export { inheritOptionFromParent } from "../cli/command-options.js";
export { runCommandWithRuntime } from "../cli/cli-utils.js";
export { formatHelpExamples } from "../cli/help-format.js";
export { registerCommandGroups } from "../cli/program/register-command-groups.js";
export type {
  CommandGroupEntry,
  CommandGroupPlaceholder,
} from "../cli/program/register-command-groups.js";
export { parseDurationMs } from "../cli/parse-duration.js";
export { resolveCliArgvInvocation } from "../cli/argv-invocation.js";
export { shouldEagerRegisterSubcommands } from "../cli/command-registration-policy.js";

export { note } from "../../packages/terminal-core/src/note.js";
export { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
export { theme } from "../../packages/terminal-core/src/theme.js";
export { resolveRuntimeServiceVersion, VERSION } from "../version.js";
