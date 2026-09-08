import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readClawManifestFile } from "../claws/reader.js";
import type { ClawManifest } from "../claws/types.js";
import { pathExists } from "../utils.js";
import { resolveWorkspaceTemplateSearchDirs } from "./workspace-templates.js";

const AGENT_ROLES = ["coordinator", "researcher", "writer", "reviewer"] as const;
export type AgentRoleId = (typeof AGENT_ROLES)[number];

export function listAgentRoles(): readonly AgentRoleId[] {
  return AGENT_ROLES;
}

const memberSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    role: z.enum(AGENT_ROLES),
  })
  .strict();
const teamPresetSchema = z
  .object({
    schemaVersion: z.literal(1),
    coordinator: memberSchema,
    specialists: z.array(memberSchema).min(1),
  })
  .strict()
  .refine(
    ({ coordinator, specialists }) =>
      new Set([coordinator.id, ...specialists.map((member) => member.id)]).size ===
      specialists.length + 1,
    { message: "Team member ids must be unique" },
  );

async function resolveCatalogFile(...segments: string[]): Promise<string> {
  for (const templatesDir of await resolveWorkspaceTemplateSearchDirs()) {
    const candidate = path.join(templatesDir, "roles", ...segments);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Bundled agent role is missing: ${segments.join("/")}`);
}

export async function loadAgentRole(role: string): Promise<{
  manifest: ClawManifest;
  identity: { name: string; emoji: string; theme: string };
  files: Record<"AGENTS.md" | "SOUL.md" | "IDENTITY.md", string>;
}> {
  if (!AGENT_ROLES.some((candidate) => candidate === role)) {
    throw new Error(`Unknown agent role "${role}". Available roles: ${AGENT_ROLES.join(", ")}.`);
  }
  const read = await readClawManifestFile(await resolveCatalogFile(role, "CLAW.md"));
  if (!read.ok) {
    throw new Error(read.diagnostics.map(({ message }) => message).join("\n"));
  }
  const { manifest } = read;
  const identity = manifest.agent.identity;
  const agentsSource = manifest.workspace.bootstrapFiles["AGENTS.md"]?.source;
  if (
    manifest.agent.id !== role ||
    !identity?.name ||
    !identity.emoji ||
    !identity.theme ||
    !agentsSource ||
    !read.clawMarkdownBody
  ) {
    throw new Error(
      `Agent role "${role}" requires its matching id, complete identity, AGENTS.md, and SOUL body.`,
    );
  }
  return {
    manifest,
    identity: { name: identity.name, emoji: identity.emoji, theme: identity.theme },
    files: {
      "AGENTS.md": await fs.readFile(path.join(read.source.packageRoot, agentsSource), "utf8"),
      "SOUL.md": read.clawMarkdownBody.toString("utf8"),
      "IDENTITY.md": `# Identity\n\n- **Name:** ${identity.name}\n- **Creature:** ${role} assistant\n- **Vibe:** ${identity.theme}\n- **Emoji:** ${identity.emoji}\n- **Theme:** ${identity.theme}\n`,
    },
  };
}

export async function loadAgentTeamPreset(preset = "team") {
  if (preset !== "team") {
    throw new Error(`Unknown agent team preset "${preset}". Available presets: team.`);
  }
  const presetPath = await resolveCatalogFile("presets", `${preset}.json`);
  return teamPresetSchema.parse(JSON.parse(await fs.readFile(presetPath, "utf8")));
}
