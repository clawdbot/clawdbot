import { z } from "zod";
import { execSync } from "child_process";

function runSkillkit(args: string): string {
  try {
    return execSync(`npx skillkit ${args}`, {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();
  } catch (error: any) {
    return error.message || "Command failed";
  }
}

export const SkillkitSearchSchema = z.object({
  query: z.string().describe("Search query for skills"),
  agent: z
    .string()
    .optional()
    .describe("Filter by agent (e.g., cursor, claude-code, codex)"),
  limit: z.number().optional().default(10).describe("Maximum results"),
});

export async function executeSkillkitSearch(
  params: z.infer<typeof SkillkitSearchSchema>,
): Promise<string> {
  const args = [`search "${params.query}"`];
  if (params.agent) args.push(`--agent ${params.agent}`);
  if (params.limit) args.push(`--limit ${params.limit}`);
  return runSkillkit(args.join(" "));
}

export const SkillkitInstallSchema = z.object({
  skill: z.string().describe("Skill name or URL to install"),
  agent: z
    .string()
    .optional()
    .default("clawdbot")
    .describe("Target agent for installation"),
});

export async function executeSkillkitInstall(
  params: z.infer<typeof SkillkitInstallSchema>,
): Promise<string> {
  return runSkillkit(`install "${params.skill}" --agent ${params.agent}`);
}

export const SkillkitTranslateSchema = z.object({
  skill: z.string().describe("Skill name or path to translate"),
  from: z.string().describe("Source agent format"),
  to: z.string().default("clawdbot").describe("Target agent format"),
  recursive: z
    .boolean()
    .optional()
    .default(false)
    .describe("Translate all skills in directory"),
});

export async function executeSkillkitTranslate(
  params: z.infer<typeof SkillkitTranslateSchema>,
): Promise<string> {
  const args = [`translate "${params.skill}" --from ${params.from} --to ${params.to}`];
  if (params.recursive) args.push("--recursive");
  return runSkillkit(args.join(" "));
}

export const SkillkitRecommendSchema = z.object({
  path: z
    .string()
    .optional()
    .default(".")
    .describe("Project path to analyze for recommendations"),
  limit: z.number().optional().default(5).describe("Maximum recommendations"),
});

export async function executeSkillkitRecommend(
  params: z.infer<typeof SkillkitRecommendSchema>,
): Promise<string> {
  return runSkillkit(`recommend --path "${params.path}" --limit ${params.limit}`);
}

export const SkillkitSyncSchema = z.object({
  direction: z
    .enum(["push", "pull"])
    .describe("Sync direction (push local to remote, pull remote to local)"),
  agent: z
    .string()
    .optional()
    .default("clawdbot")
    .describe("Agent to sync skills for"),
});

export async function executeSkillkitSync(
  params: z.infer<typeof SkillkitSyncSchema>,
): Promise<string> {
  return runSkillkit(`sync ${params.direction} --agent ${params.agent}`);
}

export const SkillkitListSchema = z.object({
  agent: z.string().optional().describe("Filter by agent"),
  installed: z
    .boolean()
    .optional()
    .default(false)
    .describe("Show only installed skills"),
});

export async function executeSkillkitList(
  params: z.infer<typeof SkillkitListSchema>,
): Promise<string> {
  const args = ["list"];
  if (params.agent) args.push(`--agent ${params.agent}`);
  if (params.installed) args.push("--installed");
  return runSkillkit(args.join(" "));
}

export const SkillkitContextSchema = z.object({
  path: z.string().optional().default(".").describe("Project path to analyze"),
  format: z
    .enum(["json", "text"])
    .optional()
    .default("text")
    .describe("Output format"),
});

export async function executeSkillkitContext(
  params: z.infer<typeof SkillkitContextSchema>,
): Promise<string> {
  return runSkillkit(`context --path "${params.path}" --format ${params.format}`);
}

export const SkillkitPublishSchema = z.object({
  path: z.string().optional().default(".").describe("Path to skill directory"),
  name: z.string().optional().describe("Skill name (defaults to directory name)"),
});

export async function executeSkillkitPublish(
  params: z.infer<typeof SkillkitPublishSchema>,
): Promise<string> {
  const args = ["publish"];
  if (params.path !== ".") args.push(`--path "${params.path}"`);
  if (params.name) args.push(`--name "${params.name}"`);
  return runSkillkit(args.join(" "));
}

export const SkillkitMemorySchema = z.object({
  action: z
    .enum(["save", "load", "list", "clear"])
    .describe("Memory action to perform"),
  key: z.string().optional().describe("Memory key (for save/load)"),
  value: z.string().optional().describe("Value to save (for save action)"),
});

export async function executeSkillkitMemory(
  params: z.infer<typeof SkillkitMemorySchema>,
): Promise<string> {
  const args = [`memory ${params.action}`];
  if (params.key) args.push(`--key "${params.key}"`);
  if (params.value) args.push(`--value "${params.value}"`);
  return runSkillkit(args.join(" "));
}
