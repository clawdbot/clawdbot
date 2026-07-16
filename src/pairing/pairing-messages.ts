// Formats pairing challenge replies and setup instructions.
import { formatCliCommand } from "../cli/command-format.js";
import type { PairingChannel } from "./pairing-store.types.js";

// User-facing pairing reply formatter sent to unapproved channel users. The
// owner command is formatted through CLI helpers so profiles/aliases stay valid.
export function buildPairingReply(params: {
  channel: PairingChannel;
  idLine: string;
  code: string;
  template?: string;
}): string {
  const { channel, idLine, code, template } = params;
  const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
  const defaultReply = [
    "OpenClaw: access not configured.",
    "",
    idLine,
    "Pairing code:",
    "```",
    code,
    "```",
    "",
    "Ask the bot owner to approve with:",
    "```",
    approveCommand,
    "```",
  ].join("\n");
  if (template === undefined) {
    return defaultReply;
  }
  const variables = {
    channel,
    senderIdLine: idLine,
    code,
    approveCommand,
  };
  return template.replaceAll(
    /\{(channel|senderIdLine|code|approveCommand)\}/g,
    (_match, name: keyof typeof variables) => variables[name],
  );
}
