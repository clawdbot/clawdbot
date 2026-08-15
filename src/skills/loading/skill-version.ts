// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";

export function computeSkillPromptVersion(content: string): string {
  return `sha256:${sha256HexPrefixCore(content, 16)}`;
}
