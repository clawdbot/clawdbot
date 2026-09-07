import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../utils.js";
import {
  AGENT_TEMPLATE_ROLES,
  agentTeamPresetSchema,
  agentTemplateManifestSchema,
  type AgentTemplateFile,
  type AgentTemplateManifest,
} from "./agent-template-schema.js";
import { resolveWorkspaceTemplateSearchDirs } from "./workspace-templates.js";

export type AgentTemplate = {
  manifest: AgentTemplateManifest;
  files: Record<AgentTemplateFile, string>;
};

async function resolveCatalogFile(...segments: string[]): Promise<string> {
  for (const templatesDir of await resolveWorkspaceTemplateSearchDirs()) {
    const candidate = path.join(templatesDir, "roles", ...segments);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Bundled agent template is missing: ${segments.join("/")}`);
}

export async function loadAgentTemplate(role: string): Promise<AgentTemplate> {
  if (!AGENT_TEMPLATE_ROLES.some((candidate) => candidate === role)) {
    throw new Error(
      `Unknown agent role "${role}". Available roles: ${AGENT_TEMPLATE_ROLES.join(", ")}.`,
    );
  }
  const manifestPath = await resolveCatalogFile(role, "manifest.json");
  const manifest = agentTemplateManifestSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
  );
  if (manifest.role !== role) {
    throw new Error(`Agent template "${role}" declares a different role: ${manifest.role}`);
  }
  const workspaceDir = path.join(path.dirname(manifestPath), "workspace");
  const read = (file: AgentTemplateFile) => fs.readFile(path.join(workspaceDir, file), "utf8");
  const [agents, soul, identity] = await Promise.all([
    read("AGENTS.md"),
    read("SOUL.md"),
    read("IDENTITY.md"),
  ]);
  return { manifest, files: { "AGENTS.md": agents, "SOUL.md": soul, "IDENTITY.md": identity } };
}

export async function loadAgentTeamPreset(preset = "team") {
  if (preset !== "team") {
    throw new Error(`Unknown agent team preset "${preset}". Available presets: team.`);
  }
  const presetPath = await resolveCatalogFile("presets", `${preset}.json`);
  return agentTeamPresetSchema.parse(JSON.parse(await fs.readFile(presetPath, "utf8")));
}
