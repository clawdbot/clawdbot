import type { PairingProvider } from "./pairing-store.js";

export function buildPairingReply(params: {
  provider: PairingProvider;
  idLine: string;
  code: string;
}): string {
  const { provider, idLine, code } = params;
  return [
    "Clawdbot: access not configured.",
    "",
    idLine,
    "",
    `Pairing code: ${code}`,
    "",
    "Ask the bot owner to approve with:",
    `clawdbot pairing approve ${provider} <code>`,
  ].join("\n");
}
