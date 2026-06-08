// Skill prompt versions are deterministic content markers for model-visible skill catalogs.
import crypto from "node:crypto";

export function computeSkillPromptVersion(content: string): string {
  const digest = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}
