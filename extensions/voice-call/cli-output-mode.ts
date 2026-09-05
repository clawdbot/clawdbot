import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

const MACHINE_OUTPUT_COMMANDS = new Set([
  "call",
  "continue",
  "dtmf",
  "end",
  "expose",
  "latency",
  "speak",
  "start",
  "status",
  "tail",
]);

/** Voice-call result actions emit JSON, while tail reserves stdout for JSONL. */
function isVoiceCallMachineOutput(params: { argv: readonly string[] }): boolean {
  const [, command] = getRootOptionAwareCommandPath(params.argv, 2);
  return MACHINE_OUTPUT_COMMANDS.has(command ?? "");
}

export const VOICE_CALL_CLI_DESCRIPTOR = {
  name: "voicecall",
  description: "Voice call utilities",
  hasSubcommands: true,
  machineOutput: isVoiceCallMachineOutput,
} as const;
