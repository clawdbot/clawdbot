// Small help-text formatter shared by command registrations.
import { theme } from "../../packages/terminal-core/src/theme.js";

/** Command plus short description tuple used in help epilogues. */
type HelpExample = readonly [command: string, description: string];

function formatHelpExample(command: string, description: string): string {
  return `  ${theme.command(command)}\n    ${theme.muted(description)}`;
}

function formatHelpExampleLine(command: string, description: string): string {
  if (!description) {
    return `  ${theme.command(command)}`;
  }
  return `  ${theme.command(command)} ${theme.muted(`# ${description}`)}`;
}

/** Render help examples in stacked or inline comment style. */
export function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline = false): string {
  const formatter = inline ? formatHelpExampleLine : formatHelpExample;
  return examples.map(([command, description]) => formatter(command, description)).join("\n");
}
