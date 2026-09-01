import { createHash } from "node:crypto";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";

const CLI_IMAGE_TURN_LABEL = "Image turn:";
const CLI_IMAGE_TURN_HEADER = markInboundContextLabel(CLI_IMAGE_TURN_LABEL);
// Only a complete producer block is correlation evidence. Conflicting or
// malformed copies must fail open so history merge cannot hide a real turn.
const CLI_IMAGE_TURN_BLOCK_PATTERN = new RegExp(
  `${CLI_IMAGE_TURN_HEADER}\\n\`\`\`json\\n\\{"turnKey":"([a-f0-9]{64})"\\}\\n\`\`\``,
  "g",
);

export function hashCliImageTurnEntryId(entryId: string): string {
  return createHash("sha256").update(entryId).digest("hex");
}

export function formatCliImageTurnContext(turnKey: string): string {
  return `${CLI_IMAGE_TURN_HEADER}\n\`\`\`json\n${JSON.stringify({ turnKey })}\n\`\`\``;
}

export function readCliImageTurnContext(text: string): string | undefined {
  const keys = Array.from(text.matchAll(CLI_IMAGE_TURN_BLOCK_PATTERN), (match) => match[1]);
  if (keys.length !== text.split(CLI_IMAGE_TURN_HEADER).length - 1) {
    return undefined;
  }
  const first = keys[0];
  return first && keys.every((key) => key === first) ? first : undefined;
}

export function stripCliImageTurnContext(text: string, turnKey: string): string {
  const block = formatCliImageTurnContext(turnKey);
  return text
    .replace(`\n\n${block}\n\n`, "\n\n")
    .replace(`${block}\n\n`, "")
    .replace(`\n\n${block}`, "");
}
