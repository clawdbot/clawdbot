import { sha256Hex } from "../../infra/crypto-digest.js";

export function hashSkillProposalContent(content: string): string {
  return sha256Hex(content);
}
