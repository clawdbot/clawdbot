/** Declarative manifest for installable OpenClaw skills. */
export type SkillRisk = "low" | "medium" | "high";

export type SkillManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  capabilities: string[];
  tools?: string[];
  connectors?: string[];
  dependencies?: string[];
  supportedAgents?: string[];
  permissions?: string[];
  risk?: SkillRisk;
};

export type SkillInstallState =
  | "available"
  | "installing"
  | "installed"
  | "disabled"
  | "failed";

export type InstalledSkill = SkillManifest & {
  state: SkillInstallState;
  installedAt?: string;
};

export function validateSkillManifest(manifest: SkillManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id.trim()) errors.push("Skill id is required");
  if (!manifest.name.trim()) errors.push("Skill name is required");
  if (!manifest.version.trim()) errors.push("Skill version is required");
  if (!Array.isArray(manifest.capabilities)) errors.push("Skill capabilities are required");
  return errors;
}

export function getSkillInstallRequirements(manifest: SkillManifest): {
  permissions: string[];
  connectors: string[];
  dependencies: string[];
} {
  return {
    permissions: [...(manifest.permissions ?? [])],
    connectors: [...(manifest.connectors ?? [])],
    dependencies: [...(manifest.dependencies ?? [])],
  };
}
