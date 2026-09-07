import { z } from "zod";

export const AGENT_TEMPLATE_ROLES = ["coordinator", "researcher", "writer", "reviewer"] as const;
const AGENT_TEMPLATE_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md"] as const;
const roleSchema = z.enum(AGENT_TEMPLATE_ROLES);
const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const textSchema = z.string().trim().min(1);

export const agentTemplateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: roleSchema,
    title: textSchema,
    summary: textSchema,
    identity: z.object({ name: textSchema, emoji: textSchema, theme: textSchema }).strict(),
    skills: z.array(textSchema).optional(),
    subagents: z
      .object({
        allowAgents: z.array(agentIdSchema).optional(),
        delegationMode: z.enum(["suggest", "prefer"]).optional(),
      })
      .strict()
      .optional(),
    files: z
      .array(z.enum(AGENT_TEMPLATE_FILES))
      .length(AGENT_TEMPLATE_FILES.length)
      .refine((files) => new Set(files).size === AGENT_TEMPLATE_FILES.length, {
        message: "List AGENTS.md, SOUL.md, and IDENTITY.md exactly once",
      }),
  })
  .strict();

const memberSchema = z.object({ id: agentIdSchema, role: roleSchema }).strict();
export const agentTeamPresetSchema = z
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

export type AgentTemplateManifest = z.infer<typeof agentTemplateManifestSchema>;
export type AgentTemplateFile = (typeof AGENT_TEMPLATE_FILES)[number];
