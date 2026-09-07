import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errors.js";
import { canonicalPathFromExistingAncestor } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { scanSkillContent } from "../skills/security/scanner.js";
import { resolveUserPath } from "../utils.js";
import { listAgentEntries } from "./agent-scope-config.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  agentTemplateAutomationsSchema,
  exportAgentTemplateAutomations,
  validateAgentTemplateAutomations,
  type AgentTemplateAutomation,
} from "./agent-template-automations.js";
import { AGENT_TEMPLATE_FILES, agentTemplateManifestSchema } from "./agent-template-schema.js";
import {
  AGENT_TEMPLATE_MAX_FILES,
  AGENT_TEMPLATE_MAX_FILE_BYTES,
  AGENT_TEMPLATE_MAX_TOTAL_BYTES,
  loadAgentTemplateDirectory,
  readAgentTemplateFile,
  type AgentTemplate,
} from "./agent-templates.js";
import { parseIdentityMarkdown } from "./identity-file.js";

type Bundle = { template: AgentTemplate; automations: AgentTemplateAutomation[] };
const bundlePaths = new Set([
  "manifest.json",
  ...AGENT_TEMPLATE_FILES.map((file) => `workspace/${file}`),
  "automations.json",
]);

function bundleContents({ template, automations }: Bundle): Map<string, string> {
  const contents = new Map<string, string>([
    ["manifest.json", `${JSON.stringify(template.manifest, null, 2)}\n`],
    ...AGENT_TEMPLATE_FILES.map((file): [string, string] => [
      `workspace/${file}`,
      template.files[file],
    ]),
  ]);
  if (automations.length) {
    contents.set("automations.json", `${JSON.stringify(automations, null, 2)}\n`);
  }
  return contents;
}

function checkPortableContents(contents: Map<string, string>): string[] {
  let total = 0;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (contents.size > AGENT_TEMPLATE_MAX_FILES) {
    throw new Error("Template exceeds 32 files.");
  }
  for (const [file, content] of contents) {
    const size = Buffer.byteLength(content);
    total += size;
    if (size > AGENT_TEMPLATE_MAX_FILE_BYTES || total > AGENT_TEMPLATE_MAX_TOTAL_BYTES) {
      throw new Error(`Template exceeds the 256 KiB per-file or 2 MiB total limit: ${file}`);
    }
    for (const finding of scanSkillContent(content, file)) {
      if (finding.ruleId === "literal-secret") {
        problems.push(`${file}:${finding.line}: probable secret; remove it before exporting`);
      }
    }
    // Embedded paths need review before sharing, but do not prevent a round-trip.
    for (const [line, text] of content.split("\n").entries()) {
      const localText = text.replace(
        /(?<![\p{L}\p{M}\p{N}])(?!file:)[a-z][a-z\d+.-]{1,31}:\/\/[\p{L}\p{M}\p{N}.%:/?#=&-]+/giu,
        " ",
      );
      if (
        /\bfile:\/\/|(?:^|[^\p{L}\p{M}\p{N}._~/\\-]|\\[nrt])[_~]*(?:\/[^\s"'`<>]|[a-z]:[\\/]|\\\\|~\/)/iu.test(
          localText,
        )
      ) {
        warnings.push(`${file}:${line + 1}: absolute local path; replace it with a relative path`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`Template is not portable:\n${problems.join("\n")}`);
  }
  return warnings;
}

export async function loadAgentTemplateBundle(directory: string): Promise<Bundle> {
  let total = 0;
  let count = 0;
  async function inspect(relative: string): Promise<void> {
    const absolute = path.join(directory, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Template symlinks are not allowed: ${relative || "."}`);
    }
    if (stat.isDirectory() && (relative === "" || relative === "workspace")) {
      const entries = await fs.opendir(absolute);
      for await (const entry of entries) {
        await inspect(relative ? `${relative}/${entry.name}` : entry.name);
      }
      return;
    }
    if (!stat.isFile() || !bundlePaths.has(relative)) {
      throw new Error(`Unexpected template file: ${relative}`);
    }
    total += stat.size;
    if (
      ++count > AGENT_TEMPLATE_MAX_FILES ||
      stat.size > AGENT_TEMPLATE_MAX_FILE_BYTES ||
      total > AGENT_TEMPLATE_MAX_TOTAL_BYTES
    ) {
      throw new Error("Template exceeds 32 files, 256 KiB per file, or 2 MiB total.");
    }
  }
  await inspect("");
  const template = await loadAgentTemplateDirectory(directory);
  const automationText = await readAgentTemplateFile(directory, "automations.json").catch(
    (error: unknown) => {
      if (
        hasErrnoCode(error, "ENOENT") ||
        (error instanceof Error && "code" in error && error.code === "not-found")
      ) {
        return undefined;
      }
      throw error;
    },
  );
  let automations: AgentTemplateAutomation[] = [];
  if (automationText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(automationText);
    } catch {
      throw new Error("Invalid automations.json JSON.");
    }
    const result = agentTemplateAutomationsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        "Invalid automations.json: expected sanitized agent-turn jobs with valid time schedules.",
      );
    }
    automations = result.data;
  }
  const bundle = { template, automations };
  checkPortableContents(bundleContents(bundle));
  return bundle;
}

export async function exportAgentTemplateBundle(
  cfg: OpenClawConfig,
  agentId: string,
  out: string,
  force = false,
) {
  const entry = listAgentEntries(cfg).find((agent) => agent.id === agentId);
  if (!entry) {
    throw new Error(`Agent "${agentId}" does not exist.`);
  }
  const workspace = resolveAgentWorkspaceDir(cfg, agentId);
  const files = {
    "AGENTS.md": await readAgentTemplateFile(workspace, "AGENTS.md"),
    "SOUL.md": await readAgentTemplateFile(workspace, "SOUL.md"),
    "IDENTITY.md": await readAgentTemplateFile(workspace, "IDENTITY.md"),
  };
  const parsedIdentity = parseIdentityMarkdown(files["IDENTITY.md"]);
  const identity = { ...parsedIdentity, ...entry.identity };
  const manifest = agentTemplateManifestSchema.parse({
    schemaVersion: 1,
    title: entry.name || identity.name || agentId,
    summary: entry.description || `Portable template for ${entry.name || identity.name || agentId}`,
    identity: {
      name: identity.name || entry.name || agentId,
      emoji: identity.emoji,
      theme: identity.theme,
    },
    ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.subagents
      ? {
          subagents: {
            allowAgents: entry.subagents.allowAgents,
            delegationMode: entry.subagents.delegationMode,
          },
        }
      : {}),
    files: [...AGENT_TEMPLATE_FILES],
  });
  const { resolveCronJobsStorePathFromConfig, loadCronJobsStoreWithConfigJobsReadOnly } =
    await import("../cron/store.js");
  const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(
    resolveCronJobsStorePathFromConfig(cfg),
  );
  const { automations, omissions } = exportAgentTemplateAutomations(loaded.store.jobs, agentId);
  const contents = bundleContents({ template: { manifest, files }, automations });
  const warnings = checkPortableContents(contents);
  await validateAgentTemplateAutomations(cfg, agentId, automations);
  const destination = resolveUserPath(out);
  // A forced export may replace its output directory, never the source or installation root.
  const parent = await canonicalPathFromExistingAncestor(path.dirname(destination));
  const requestedOutput = path.join(parent, path.basename(destination));
  const existing = await fs.lstat(requestedOutput).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Export output must be a real directory, not a symlink.");
  }
  const output = existing ? await fs.realpath(requestedOutput) : requestedOutput;
  for (const protectedPath of [workspace, resolveAgentDir(cfg, agentId), resolveStateDir()]) {
    const canonical = await canonicalPathFromExistingAncestor(protectedPath);
    if (
      output === canonical ||
      isPathInside(output, canonical) ||
      (protectedPath !== resolveStateDir() && isPathInside(canonical, output))
    ) {
      throw new Error("Export output overlaps the source workspace or agent state.");
    }
  }
  if (existing && (await fs.readdir(output)).length && !force) {
    throw new Error("Export output is not empty; use --force to replace it.");
  }
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, ".agent-template-"));
  const backup = `${staging}.previous`;
  let moved = false;
  try {
    await fs.mkdir(path.join(staging, "workspace"));
    for (const [file, content] of contents) {
      await fs.writeFile(path.join(staging, file), content, { flag: "wx", mode: 0o600 });
    }
    if (existing && !force) {
      // The directory must still be empty at publication, even after staging awaited IO.
      await fs.rmdir(output);
    } else if (existing) {
      await fs.rename(output, backup);
      moved = true;
    }
    try {
      await fs.rename(staging, output);
    } catch (error) {
      if (moved) {
        await fs.rename(backup, output);
        moved = false;
      }
      throw error;
    }
    if (moved) {
      await fs.rm(backup, { recursive: true });
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return {
    agentId,
    out: output,
    files: [...contents.keys()],
    automations: automations.length,
    warnings,
    omissions: [
      "USER.md not exported",
      "MEMORY.md and memory/ not exported",
      "BOOTSTRAP.md not exported",
      "Credentials, auth profiles, sessions, agentDir, and other personal files not exported",
      "Automation delivery, session bindings, tool policy, and runtime state not exported",
      ...(identity.avatar ? ["Identity avatar not exported"] : []),
      ...omissions,
    ],
  };
}
