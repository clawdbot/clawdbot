const ANSI_SGR_PATTERN = "\\x1b\\[[0-9;]*m";
// OSC-8 hyperlinks: ESC ] 8 ; ; url ST ... ESC ] 8 ; ; ST
const OSC8_PATTERN = "\\x1b\\]8;;.*?\\x1b\\\\|\\x1b\\]8;;\\x1b\\\\";

const ANSI_REGEX = new RegExp(ANSI_SGR_PATTERN, "g");
const OSC8_REGEX = new RegExp(OSC8_PATTERN, "g");

export function stripAnsi(input: string): string {
  return input.replace(OSC8_REGEX, "").replace(ANSI_REGEX, "");
}

export function visibleWidth(input: string): number {
  return Array.from(stripAnsi(input)).length;
}
