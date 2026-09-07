/** Doctor-owned migration from workspace TOOLS.md into the AGENTS.md Tools section. */
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { publishFileNoClobber, syncDirectoryIfSupported } from "../infra/directory-durability.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";
import {
  describeToolsMdMergedBootstrapLimits,
  resolveToolsMdMigrationWorkspaceTargets,
} from "./doctor-tools-md-migration-budget.js";
import { shouldMergeToolsMd } from "./doctor-tools-md-migration-content.js";
import { rewriteLegacyAgentsToolsGuidance as rewriteLegacyToolsGuidance } from "./doctor-tools-md-migration-guidance.js";

const TOOLS_MD_MIGRATION_CHECK_ID = "core/doctor/tools-md-migration";
const MIGRATED_SUBSECTION_HEADING = "### Local notes (migrated from TOOLS.md)";
const NO_CLOBBER_PUBLICATION = {
  strategy: "link-or-copy",
  durability: "degrade",
} as const;

type ToolsMdMigrationResult = {
  changes: string[];
  warnings: string[];
};

type ToolsMdSource = {
  path: string;
  content: string;
  sha256: string;
  stat: syncFs.Stats;
};

type MigrationFileSnapshot = {
  content: string;
  stat?: syncFs.Stats;
};

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readMigrationFileSnapshot(params: {
  filePath: string;
  label: string;
  allowMissing?: boolean;
}): Promise<MigrationFileSnapshot> {
  let stat: syncFs.Stats;
  try {
    stat = await fs.lstat(params.filePath);
  } catch (error) {
    if (params.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "" };
    }
    throw error;
  }
  if (!stat.isFile() || stat.nlink > 1) {
    throw new Error(`${params.label} must be an unlinked regular file for automatic migration`);
  }
  const noFollow = syncFs.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(params.filePath, syncFs.constants.O_RDONLY | noFollow);
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.nlink !== 1 ||
      openedStat.dev !== stat.dev ||
      openedStat.ino !== stat.ino
    ) {
      throw new Error(`${params.label} changed while opening it for migration`);
    }
    const content = await handle.readFile("utf8");
    const currentStat = await fs.lstat(params.filePath);
    if (currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
      throw new Error(`${params.label} changed while opening it for migration`);
    }
    return { content, stat: openedStat };
  } finally {
    await handle.close();
  }
}

async function readToolsMd(workspaceDir: string): Promise<ToolsMdSource | undefined> {
  const entries = await fs.readdir(workspaceDir).catch(() => [] as string[]);
  const betaArtifacts = entries.filter(
    (entry) =>
      entry.startsWith(`${DEFAULT_TOOLS_FILENAME}.doctor-importing-`) ||
      entry.startsWith(`${DEFAULT_AGENTS_FILENAME}.doctor-backup-`),
  );
  if (betaArtifacts.length > 0) {
    throw new Error(
      `Interrupted v2026.7.2-beta.5 migration artifact(s) left untouched: ${betaArtifacts.join(", ")}. Restore the desired file manually before rerunning doctor.`,
    );
  }
  const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
  const snapshot = await readMigrationFileSnapshot({
    filePath: toolsPath,
    label: "TOOLS.md",
    allowMissing: true,
  });
  if (!snapshot.stat) {
    return undefined;
  }
  return {
    path: toolsPath,
    content: snapshot.content,
    sha256: sha256(snapshot.content),
    stat: snapshot.stat,
  };
}

function migratedBlock(content: string): string {
  return `${MIGRATED_SUBSECTION_HEADING}\n\n${content}`;
}

function appendWithSpacing(before: string, addition: string, after = ""): string {
  const prefix =
    before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix =
    after.length === 0
      ? ""
      : addition.endsWith("\n\n")
        ? ""
        : addition.endsWith("\n")
          ? "\n"
          : "\n\n";
  return `${before}${prefix}${addition}${suffix}${after}`;
}

function mergeToolsMdIntoAgentsMd(agentsContent: string, toolsContent: string): string {
  const mergedAgentsContent = rewriteLegacyAgentsToolsGuidance(agentsContent);
  if (mergedAgentsContent.includes(MIGRATED_SUBSECTION_HEADING)) {
    if (mergedAgentsContent.includes(toolsContent)) {
      return mergedAgentsContent;
    }
    const headingIndex = mergedAgentsContent.indexOf(MIGRATED_SUBSECTION_HEADING);
    const insertAt = headingIndex + MIGRATED_SUBSECTION_HEADING.length;
    return appendWithSpacing(
      mergedAgentsContent.slice(0, insertAt),
      toolsContent,
      mergedAgentsContent.slice(insertAt),
    );
  }
  const block = migratedBlock(toolsContent);
  const toolsSection = findToolsSection(mergedAgentsContent);
  if (!toolsSection) {
    return appendWithSpacing(mergedAgentsContent, `## Tools\n\n${block}`);
  }
  const insertAt = toolsSection.insertAt;
  return appendWithSpacing(
    mergedAgentsContent.slice(0, insertAt),
    block,
    mergedAgentsContent.slice(insertAt),
  );
}

function rewriteLegacyAgentsToolsGuidance(content: string): string {
  const rewritten = rewriteLegacyToolsGuidance(content);
  return rewritten === content ? content : ensureLocalNotesHeading(rewritten);
}

function findToolsSection(content: string): { headingEnd: number; insertAt: number } | undefined {
  let offset = 0;
  let insideTools = false;
  let headingEnd = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const lineWithEnding of content.match(/.*(?:\n|$)/gu) ?? []) {
    if (lineWithEnding === "") {
      continue;
    }
    const line = lineWithEnding.replace(/\n$/u, "");
    const fenceRun = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    const closingFenceRun = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
    const marker = fenceRun?.[0] as "`" | "~" | undefined;
    if (marker && !fence) {
      fence = { marker, length: fenceRun!.length };
    } else if (
      closingFenceRun &&
      fence &&
      closingFenceRun[0] === fence.marker &&
      closingFenceRun.length >= fence.length
    ) {
      fence = undefined;
    } else if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (heading) {
        const depth = heading[1]!.length;
        if (insideTools && depth <= 2) {
          return { headingEnd, insertAt: offset };
        }
        if (depth === 2 && heading[2]!.trim().toLowerCase() === "tools") {
          insideTools = true;
          headingEnd = offset + lineWithEnding.length;
        }
      }
    }
    offset += lineWithEnding.length;
  }
  return insideTools ? { headingEnd, insertAt: content.length } : undefined;
}

function ensureLocalNotesHeading(content: string): string {
  const section = findToolsSection(content);
  if (!section) {
    return content;
  }
  const body = content.slice(section.headingEnd, section.insertAt);
  if (/^###\s+Local notes(?:\s|$)/imu.test(body)) {
    return content;
  }
  return `${content.slice(0, section.headingEnd)}\n### Local notes\n${content.slice(section.headingEnd)}`;
}

async function writeAgentsAtomically(params: {
  agentsPath: string;
  expected: string;
  content: string;
}): Promise<void> {
  const snapshot = await readMigrationFileSnapshot({
    filePath: params.agentsPath,
    label: "AGENTS.md",
    allowMissing: true,
  });
  if (snapshot.content !== params.expected) {
    throw new Error("AGENTS.md changed during TOOLS.md migration");
  }
  const stat = snapshot.stat;
  const mode = stat?.mode ?? 0o600;
  const tempPath = `${params.agentsPath}.doctor-writing-${process.pid}-${Date.now()}`;
  try {
    const handle = await fs.open(tempPath, "wx", mode);
    try {
      await handle.writeFile(params.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Doctor is a single-operator flow. This final snapshot catches edits before
    // commit without retaining the retired cross-process claim protocol.
    const current = await readMigrationFileSnapshot({
      filePath: params.agentsPath,
      label: "AGENTS.md",
      allowMissing: true,
    });
    if (
      current.content !== params.expected ||
      current.stat?.dev !== stat?.dev ||
      current.stat?.ino !== stat?.ino
    ) {
      throw new Error("AGENTS.md changed during TOOLS.md migration");
    }
    await fs.rename(tempPath, params.agentsPath);
    await syncDirectoryIfSupported(path.dirname(params.agentsPath));
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function recoverInterruptedAgentsWrite(agentsPath: string): Promise<void> {
  const dir = path.dirname(agentsPath);
  const prefix = `${path.basename(agentsPath)}.doctor-writing-`;
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  let removed = false;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const tempPath = path.join(dir, entry);
    const stat = await fs.lstat(tempPath);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`interrupted AGENTS.md write must be an unlinked regular file: ${tempPath}`);
    }
    await fs.rm(tempPath);
    removed = true;
  }
  if (removed) {
    await syncDirectoryIfSupported(dir);
  }
}

async function removeToolsSource(source: ToolsMdSource, workspaceDir: string): Promise<void> {
  const current = await readMigrationFileSnapshot({
    filePath: source.path,
    label: "TOOLS.md",
  });
  if (sha256(current.content) !== source.sha256) {
    throw new Error("TOOLS.md changed during migration");
  }
  // The original bytes are durable in both the archive and merged AGENTS.md;
  // the single-operator migration deliberately has no concurrent-writer claim.
  const currentStat = syncFs.lstatSync(source.path);
  if (
    !current.stat ||
    currentStat.dev !== current.stat.dev ||
    currentStat.ino !== current.stat.ino ||
    currentStat.dev !== source.stat.dev ||
    currentStat.ino !== source.stat.ino
  ) {
    throw new Error("TOOLS.md changed during migration");
  }
  syncFs.unlinkSync(source.path);
  await syncDirectoryIfSupported(workspaceDir);
}

function archivePathForSource(
  agentId: string,
  source: ToolsMdSource,
  env: NodeJS.ProcessEnv,
): string {
  const safeAgentId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(
    resolveStateDir(env),
    "backups",
    "tools-md-migration",
    `${safeAgentId}-${source.sha256}.md`,
  );
}

async function archiveSource(params: {
  agentId: string;
  source: ToolsMdSource;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const archivePath = archivePathForSource(params.agentId, params.source, params.env);
  const archiveDir = path.dirname(archivePath);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const tempPath = `${archivePath}.doctor-writing-${process.pid}-${Date.now()}`;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(params.source.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFileNoClobber(tempPath, archivePath, NO_CLOBBER_PUBLICATION);
    await fs.rm(tempPath);
    await syncDirectoryIfSupported(archiveDir);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (sha256(await fs.readFile(archivePath, "utf8")) !== params.source.sha256) {
      throw new Error(`TOOLS.md migration archive collision at ${archivePath}`, { cause: error });
    }
  }
  return archivePath;
}

function migrationFinding(params: {
  agentId: string;
  path: string;
  message: string;
  severity?: HealthFinding["severity"];
  requirement: string;
}): HealthFinding {
  return {
    checkId: TOOLS_MD_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to merge TOOLS.md into AGENTS.md.`,
  };
}

export async function collectToolsMdMigrationFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  for (const target of resolveToolsMdMigrationWorkspaceTargets(cfg)) {
    try {
      const source = await readToolsMd(target.workspaceDir);
      if (source) {
        findings.push(
          migrationFinding({
            agentId: target.primaryAgentId,
            path: source.path,
            message: `Agent "${target.primaryAgentId}" still stores local tool notes in TOOLS.md.`,
            requirement: "legacy-tools-md",
          }),
        );
        if (shouldMergeToolsMd(source.content)) {
          const agentsPath = path.join(target.workspaceDir, DEFAULT_AGENTS_FILENAME);
          const agentsContent = (
            await readMigrationFileSnapshot({
              filePath: agentsPath,
              label: "AGENTS.md",
              allowMissing: true,
            })
          ).content;
          const mergedChars = mergeToolsMdIntoAgentsMd(agentsContent, source.content).length;
          for (const budget of describeToolsMdMergedBootstrapLimits({
            cfg,
            agentIds: target.agentIds,
            mergedChars,
          })) {
            findings.push(
              migrationFinding({
                agentId: budget.agentId,
                path: agentsPath,
                message: budget.message,
                requirement: "tools-md-merged-bootstrap-limit",
              }),
            );
          }
        }
      }
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: target.primaryAgentId,
          path: path.join(target.workspaceDir, DEFAULT_TOOLS_FILENAME),
          message: `Agent "${target.primaryAgentId}" TOOLS.md cannot be migrated: ${errorMessage(error)}`,
          severity: "error",
          requirement: "tools-md-migration-blocked",
        }),
      );
    }
  }
  return findings;
}

export async function maybeMigrateToolsMd(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<ToolsMdMigrationResult> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const target of resolveToolsMdMigrationWorkspaceTargets(params.cfg)) {
    try {
      const source = await readToolsMd(target.workspaceDir);
      if (!source) {
        continue;
      }
      if (!params.shouldRepair) {
        note(
          `${shortenHomePath(source.path)} will be archived and merged into AGENTS.md when customized.`,
          "TOOLS.md migration preview",
        );
        continue;
      }

      const shouldMerge = shouldMergeToolsMd(source.content);
      await archiveSource({ agentId: target.primaryAgentId, source, env });
      const agentsPath = path.join(target.workspaceDir, DEFAULT_AGENTS_FILENAME);
      await recoverInterruptedAgentsWrite(agentsPath);
      const agentsContent = (
        await readMigrationFileSnapshot({
          filePath: agentsPath,
          label: "AGENTS.md",
          allowMissing: true,
        })
      ).content;
      const merged = shouldMerge
        ? mergeToolsMdIntoAgentsMd(agentsContent, source.content)
        : rewriteLegacyAgentsToolsGuidance(agentsContent);
      if (merged !== agentsContent) {
        await writeAgentsAtomically({ agentsPath, expected: agentsContent, content: merged });
        if (
          (await readMigrationFileSnapshot({ filePath: agentsPath, label: "AGENTS.md" }))
            .content !== merged
        ) {
          throw new Error("AGENTS.md changed after TOOLS.md migration was written");
        }
      }
      // Fence an earlier AGENTS rename before the durable source unlink, including reruns.
      await syncDirectoryIfSupported(target.workspaceDir);
      await removeToolsSource(source, target.workspaceDir);
      changes.push(
        shouldMerge
          ? `Merged ${shortenHomePath(source.path)} into AGENTS.md and archived the original.`
          : `Removed untouched ${shortenHomePath(source.path)} after archiving it.`,
      );
    } catch (error) {
      warnings.push(
        `Agent "${target.primaryAgentId}" TOOLS.md was not migrated: ${errorMessage(error)}`,
      );
    }
  }
  if (changes.length > 0) {
    note(changes.join("\n"), "TOOLS.md migration");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
