import fs from "node:fs/promises";
import path from "node:path";
import { root } from "../infra/fs-safe.js";
import { pathExists } from "../utils.js";
import {
  AGENT_TEMPLATE_ROLES,
  AGENT_TEMPLATE_FILES,
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

export const AGENT_TEMPLATE_MAX_FILE_BYTES = 256 * 1024;
export const AGENT_TEMPLATE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const AGENT_TEMPLATE_MAX_FILES = 32;

export async function readAgentTemplateFile(directory: string, file: string): Promise<string> {
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Template directory must be a real directory, not a symlink.");
  }
  const directoryRoot = await root(directory);
  const { buffer } = await directoryRoot.read(file, {
    symlinks: "reject",
    hardlinks: "reject",
    nonBlockingRead: true,
    maxBytes: AGENT_TEMPLATE_MAX_FILE_BYTES,
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

/** Catalog roles and portable bundles share the same manifest and workspace loader. */
export async function loadAgentTemplateDirectory(directory: string): Promise<AgentTemplate> {
  const content = await readAgentTemplateFile(directory, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Invalid template manifest.json JSON.");
  }
  const validated = agentTemplateManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      "Invalid template manifest.json: check schemaVersion, identity, settings, and workspace file paths.",
    );
  }
  const manifest = validated.data;
  const [agents, soul, identity] = await Promise.all(
    AGENT_TEMPLATE_FILES.map((file) => readAgentTemplateFile(directory, `workspace/${file}`)),
  );
  return { manifest, files: { "AGENTS.md": agents!, "SOUL.md": soul!, "IDENTITY.md": identity! } };
}

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
  const template = await loadAgentTemplateDirectory(path.dirname(manifestPath));
  if (template.manifest.role !== role) {
    throw new Error(
      `Agent template "${role}" declares a different role: ${template.manifest.role}`,
    );
  }
  return template;
}

export async function loadAgentTeamPreset(preset = "team") {
  if (preset !== "team") {
    throw new Error(`Unknown agent team preset "${preset}". Available presets: team.`);
  }
  const presetPath = await resolveCatalogFile("presets", `${preset}.json`);
  return agentTeamPresetSchema.parse(JSON.parse(await fs.readFile(presetPath, "utf8")));
}
