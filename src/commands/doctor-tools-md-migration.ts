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
const TOOLS_CLAIM_INFIX = ".doctor-importing-";
const ACTIVE_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;
const HARD_LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

type ToolsMdMigrationResult = {
  changes: string[];
  warnings: string[];
};

type ToolsMdSource = {
  path: string;
  content: string;
  sha256: string;
};

type MigrationClaimIdentity = {
  ownerPid: number;
  createdAtMs: number;
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

function parseMigrationClaimIdentity(
  claimName: string,
  prefix: string,
): MigrationClaimIdentity | undefined {
  const [ownerPidText, createdAtMsText] = claimName.slice(prefix.length).split("-");
  const ownerPid = Number(ownerPidText);
  const createdAtMs = Number(createdAtMsText);
  if (!Number.isSafeInteger(ownerPid) || !Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
    return undefined;
  }
  return { ownerPid, createdAtMs };
}

async function readToolsMd(
  workspaceDir: string,
  options?: { recoverClaims?: boolean },
): Promise<ToolsMdSource | undefined> {
  const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
  let stat;
  try {
    stat = await fs.lstat(toolsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const entries = await fs.readdir(workspaceDir).catch(() => [] as string[]);
      const claims = entries.filter((entry) =>
        entry.startsWith(`${DEFAULT_TOOLS_FILENAME}${TOOLS_CLAIM_INFIX}`),
      );
      if (claims.length === 0) {
        return undefined;
      }
      if (claims.length > 1) {
        throw new Error("multiple interrupted TOOLS.md migration claims require manual recovery", {
          cause: error,
        });
      }
      const claimPath = path.join(workspaceDir, claims[0]!);
      const claimIdentity = parseMigrationClaimIdentity(
        claims[0]!,
        `${DEFAULT_TOOLS_FILENAME}${TOOLS_CLAIM_INFIX}`,
      );
      if (
        claimIdentity &&
        claimIdentity.ownerPid !== process.pid &&
        Date.now() - claimIdentity.createdAtMs < ACTIVE_CLAIM_MAX_AGE_MS &&
        isProcessAlive(claimIdentity.ownerPid)
      ) {
        throw new Error(
          `TOOLS.md migration claim is held by running process ${claimIdentity.ownerPid}`,
          { cause: error },
        );
      }
      if (!options?.recoverClaims) {
        throw new Error("an interrupted TOOLS.md migration claim requires doctor --fix", {
          cause: error,
        });
      }
      await restoreClaimNoClobber(claimPath, toolsPath);
      stat = await fs.lstat(toolsPath);
    } else {
      throw error;
    }
  }
  if (!stat.isFile()) {
    throw new Error("TOOLS.md must be a regular file");
  }
  if (stat.nlink > 1) {
    if (!options?.recoverClaims) {
      throw new Error("an interrupted TOOLS.md migration restoration requires doctor --fix");
    }
    const entries = await fs.readdir(workspaceDir);
    const claims = entries.filter((entry) =>
      entry.startsWith(`${DEFAULT_TOOLS_FILENAME}${TOOLS_CLAIM_INFIX}`),
    );
    if (claims.length === 1) {
      const claimPath = path.join(workspaceDir, claims[0]!);
      const claimStat = await fs.lstat(claimPath);
      if (claimStat.dev === stat.dev && claimStat.ino === stat.ino && stat.nlink === 2) {
        await fs.rm(claimPath);
        stat = await fs.lstat(toolsPath);
      }
    }
    if (stat.nlink > 1) {
      throw new Error("TOOLS.md has multiple hard links; refusing automatic removal");
    }
  }
  const noFollow = syncFs.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(toolsPath, syncFs.constants.O_RDONLY | noFollow);
  let content: string;
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== stat.nlink) {
      throw new Error("TOOLS.md changed while opening it for migration");
    }
    content = await handle.readFile("utf8");
    const currentStat = await fs.lstat(toolsPath);
    if (currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
      throw new Error("TOOLS.md changed while opening it for migration");
    }
  } finally {
    await handle.close();
  }
  return { path: toolsPath, content, sha256: sha256(content) };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const handle = await fs.open(tempPath, "wx", mode);
  try {
    await handle.writeFile(params.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const backupPath = `${params.agentsPath}.doctor-backup-${process.pid}-${Date.now()}`;
  let claimed = false;
  try {
    if (stat) {
      const currentStat = await fs.lstat(params.agentsPath);
      if (
        currentStat.dev !== stat.dev ||
        currentStat.ino !== stat.ino ||
        (await readMigrationFileSnapshot({ filePath: params.agentsPath, label: "AGENTS.md" }))
          .content !== params.expected
      ) {
        throw new Error("AGENTS.md changed during TOOLS.md migration");
      }
      syncFs.renameSync(params.agentsPath, backupPath);
      claimed = true;
      publishNoClobberSync(tempPath, params.agentsPath);
      syncFs.unlinkSync(tempPath);
      if (
        (await readMigrationFileSnapshot({ filePath: backupPath, label: "AGENTS.md backup" }))
          .content !== params.expected
      ) {
        syncFs.renameSync(backupPath, params.agentsPath);
        claimed = false;
        throw new Error("AGENTS.md changed during TOOLS.md migration");
      }
    } else {
      publishNoClobberSync(tempPath, params.agentsPath);
      syncFs.unlinkSync(tempPath);
    }
    await syncDirectory(path.dirname(params.agentsPath));
    if (stat) {
      await fs.rm(backupPath);
      claimed = false;
      await syncDirectory(path.dirname(params.agentsPath));
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if (claimed) {
      try {
        await fs.lstat(params.agentsPath);
      } catch (pathError) {
        if ((pathError as NodeJS.ErrnoException).code === "ENOENT") {
          await restoreClaimNoClobber(backupPath, params.agentsPath);
        }
      }
    }
    throw error;
  }
}

async function recoverInterruptedAgentsClaim(params: {
  agentsPath: string;
  toolsContent: string;
  shouldMerge: boolean;
}): Promise<void> {
  const { agentsPath } = params;
  await recoverInterruptedAgentsPublish(agentsPath);
  const entries = await fs.readdir(path.dirname(agentsPath)).catch(() => [] as string[]);
  const prefix = `${path.basename(agentsPath)}.doctor-backup-`;
  const claims = entries.filter((entry) => entry.startsWith(prefix));
  if (claims.length === 0) {
    return;
  }
  if (claims.length > 1) {
    throw new Error("multiple interrupted AGENTS.md migration claims require manual recovery");
  }
  const claimPath = path.join(path.dirname(agentsPath), claims[0]!);
  const claimSnapshot = await readMigrationFileSnapshot({
    filePath: claimPath,
    label: "AGENTS.md migration claim",
  });
  const claimIdentity = parseMigrationClaimIdentity(claims[0]!, prefix);
  if (
    claimIdentity &&
    claimIdentity.ownerPid !== process.pid &&
    Date.now() - claimIdentity.createdAtMs < ACTIVE_CLAIM_MAX_AGE_MS &&
    isProcessAlive(claimIdentity.ownerPid)
  ) {
    throw new Error(
      `AGENTS.md migration claim is held by running process ${claimIdentity.ownerPid}`,
    );
  }
  try {
    const agentsSnapshot = await readMigrationFileSnapshot({
      filePath: agentsPath,
      label: "AGENTS.md",
    });
    const claimedContent = claimSnapshot.content;
    const expected = params.shouldMerge
      ? mergeToolsMdIntoAgentsMd(claimedContent, params.toolsContent)
      : rewriteLegacyAgentsToolsGuidance(claimedContent);
    if (agentsSnapshot.content === expected || agentsSnapshot.content === claimedContent) {
      await fs.rm(claimPath);
      return;
    }
    throw new Error(`interrupted AGENTS.md claim is preserved at ${claimPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await publishNoClobber(claimPath, agentsPath);
  await fs.rm(claimPath);
}

async function recoverInterruptedAgentsPublish(agentsPath: string): Promise<void> {
  const dir = path.dirname(agentsPath);
  const prefix = `${path.basename(agentsPath)}.doctor-writing-`;
  let agentsStat: syncFs.Stats;
  try {
    agentsStat = syncFs.lstatSync(agentsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const linkedTemps = syncFs.readdirSync(dir).filter((entry) => {
    if (!entry.startsWith(prefix)) {
      return false;
    }
    const tempStat = syncFs.lstatSync(path.join(dir, entry));
    return tempStat.isFile() && tempStat.dev === agentsStat.dev && tempStat.ino === agentsStat.ino;
  });
  if (!agentsStat.isFile() || agentsStat.nlink !== 2 || linkedTemps.length !== 1) {
    return;
  }
  // The active TOOLS.md claim excludes concurrent doctor writers here; this
  // same-inode link can only be the completed half of an interrupted publish.
  syncFs.unlinkSync(path.join(dir, linkedTemps[0]!));
  await syncDirectory(dir);
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function restoreClaimNoClobber(claimPath: string, destinationPath: string): Promise<void> {
  try {
    await publishNoClobber(claimPath, destinationPath);
    await fs.rm(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`migration claim is preserved at ${claimPath}`, { cause: error });
    }
    throw error;
  }
}

async function publishNoClobber(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.link(sourcePath, destinationPath);
  } catch (error) {
    if (!HARD_LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    await fs.copyFile(sourcePath, destinationPath, syncFs.constants.COPYFILE_EXCL);
  }
}

function publishNoClobberSync(sourcePath: string, destinationPath: string): void {
  try {
    syncFs.linkSync(sourcePath, destinationPath);
  } catch (error) {
    if (!HARD_LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    syncFs.copyFileSync(sourcePath, destinationPath, syncFs.constants.COPYFILE_EXCL);
  }
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
    await publishNoClobber(tempPath, archivePath);
    await fs.rm(tempPath);
    await syncDirectory(archiveDir);
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
      const source = await readToolsMd(target.workspaceDir, {
        recoverClaims: params.shouldRepair,
      });
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
      const claimPath = `${source.path}${TOOLS_CLAIM_INFIX}${process.pid}-${Date.now()}-${source.sha256.slice(0, 12)}`;
      await fs.rename(source.path, claimPath);
      try {
        if (sha256(await fs.readFile(claimPath, "utf8")) !== source.sha256) {
          throw new Error("TOOLS.md changed before the migration claim was acquired");
        }
        const agentsPath = path.join(target.workspaceDir, DEFAULT_AGENTS_FILENAME);
        await recoverInterruptedAgentsClaim({
          agentsPath,
          toolsContent: source.content,
          shouldMerge,
        });
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
        }
        if (sha256(await fs.readFile(claimPath, "utf8")) !== source.sha256) {
          throw new Error("TOOLS.md changed while the migration claim was held");
        }
        if (
          merged !== agentsContent &&
          (await readMigrationFileSnapshot({ filePath: agentsPath, label: "AGENTS.md" }))
            .content !== merged
        ) {
          throw new Error("AGENTS.md changed after TOOLS.md migration was written");
        }
        await fs.rm(claimPath);
        await syncDirectory(target.workspaceDir);
      } catch (error) {
        try {
          await restoreClaimNoClobber(claimPath, source.path);
        } catch (restoreError) {
          throw new Error(`TOOLS.md migration claim is preserved at ${claimPath}`, {
            cause: restoreError,
          });
        }
        throw error;
      }
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
