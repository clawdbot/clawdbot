/** Doctor-owned migration from workspace TOOLS.md into the AGENTS.md Tools section. */
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";

const TOOLS_MD_MIGRATION_CHECK_ID = "core/doctor/tools-md-migration";
const MIGRATED_SUBSECTION_HEADING = "### Local notes (migrated from TOOLS.md)";
const LEGACY_AGENTS_TOOLS_GUIDANCE =
  "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.";
const CURRENT_AGENTS_TOOLS_GUIDANCE =
  "Skills define how tools work. Keep environment-specific local notes in this section.";
const TOOLS_CLAIM_INFIX = ".doctor-importing-";
const ACTIVE_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;
const HARD_LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

const LEGACY_TOOLS_MD_TEMPLATE =
  [
    "# TOOLS.md - Local Notes",
    "",
    "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.",
    "",
    "## Examples",
    "",
    "```markdown",
    "### Cameras",
    "",
    "- living-room → Main area, 180° wide angle",
    "- front-door → Entrance, motion-triggered",
    "",
    "### SSH",
    "",
    "- home-server → 192.168.1.100, user: admin",
    "",
    "### TTS",
    "",
    '- Preferred voice: "Nova" (warm, slightly British)',
    "- Default speaker: Kitchen HomePod",
    "```",
    "",
    "## Why Separate?",
    "",
    "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.",
    "",
    "---",
    "",
    "Add whatever helps you do your job. This is your cheat sheet.",
    "",
    "## Related",
    "",
    "- [Agent workspace](/concepts/agent-workspace)",
  ].join("\n") + "\n";

const LEGACY_TOOLS_DEV_MD_TEMPLATE =
  [
    "# TOOLS.md - User Tool Notes (editable)",
    "",
    "This file is for _your_ notes about external tools and conventions. It does not define which tools exist; OpenClaw provides built-in tools internally, and skills add the rest.",
    "",
    "## Examples",
    "",
    "### imsg",
    "",
    "- Send an iMessage/SMS: describe who/what, confirm before sending.",
    "- Prefer short messages; avoid sending secrets.",
    "",
    "### sag",
    "",
    "- Text-to-speech: specify voice, target speaker/room, and whether to stream.",
    "",
    "Add whatever else you want the assistant to know about your local toolchain.",
    "",
    "## Related",
    "",
    "- [TOOLS.md template](/reference/templates/TOOLS)",
  ].join("\n") + "\n";
const LEGACY_TOOLS_DEV_FALLBACK =
  "# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n";

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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

function workspaceTargets(cfg: OpenClawConfig): Array<{ agentId: string; workspaceDir: string }> {
  const seen = new Set<string>();
  return listAgentIds(cfg).flatMap((agentId) => {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const key = path.resolve(workspaceDir);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ agentId, workspaceDir }];
  });
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
  const hadLegacyGuidance = agentsContent.includes(LEGACY_AGENTS_TOOLS_GUIDANCE);
  let mergedAgentsContent = agentsContent.replace(
    LEGACY_AGENTS_TOOLS_GUIDANCE,
    CURRENT_AGENTS_TOOLS_GUIDANCE,
  );
  if (hadLegacyGuidance) {
    mergedAgentsContent = ensureLocalNotesHeading(mergedAgentsContent);
  }
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
  const current = await fs.readFile(params.agentsPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (current !== params.expected) {
    throw new Error("AGENTS.md changed during TOOLS.md migration");
  }
  const stat = await fs.lstat(params.agentsPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (stat && (!stat.isFile() || stat.nlink > 1)) {
    throw new Error("AGENTS.md must be an unlinked regular file for automatic migration");
  }
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
        (await fs.readFile(params.agentsPath, "utf8")) !== params.expected
      ) {
        throw new Error("AGENTS.md changed during TOOLS.md migration");
      }
      syncFs.renameSync(params.agentsPath, backupPath);
      claimed = true;
      publishNoClobberSync(tempPath, params.agentsPath);
      syncFs.unlinkSync(tempPath);
      if ((await fs.readFile(backupPath, "utf8")) !== params.expected) {
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
    await fs.lstat(agentsPath);
    const claimedContent = await fs.readFile(claimPath, "utf8");
    const expected = params.shouldMerge
      ? mergeToolsMdIntoAgentsMd(claimedContent, params.toolsContent)
      : ensureLocalNotesHeading(
          claimedContent.replace(LEGACY_AGENTS_TOOLS_GUIDANCE, CURRENT_AGENTS_TOOLS_GUIDANCE),
        );
    if ((await fs.readFile(agentsPath, "utf8")) === expected) {
      await fs.rm(claimPath);
      return;
    }
    if ((await fs.readFile(agentsPath, "utf8")) === claimedContent) {
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
  for (const target of workspaceTargets(cfg)) {
    try {
      const source = await readToolsMd(target.workspaceDir);
      if (source) {
        findings.push(
          migrationFinding({
            agentId: target.agentId,
            path: source.path,
            message: `Agent "${target.agentId}" still stores local tool notes in TOOLS.md.`,
            requirement: "legacy-tools-md",
          }),
        );
      }
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: target.agentId,
          path: path.join(target.workspaceDir, DEFAULT_TOOLS_FILENAME),
          message: `Agent "${target.agentId}" TOOLS.md cannot be migrated: ${errorMessage(error)}`,
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
  for (const target of workspaceTargets(params.cfg)) {
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

      const shouldMerge =
        source.content.trim().length > 0 &&
        source.content !== LEGACY_TOOLS_MD_TEMPLATE &&
        source.content !== LEGACY_TOOLS_DEV_MD_TEMPLATE &&
        source.content !== LEGACY_TOOLS_DEV_FALLBACK;
      await archiveSource({ agentId: target.agentId, source, env });
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
        let agentsContent = "";
        try {
          agentsContent = await fs.readFile(agentsPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        const merged = shouldMerge
          ? mergeToolsMdIntoAgentsMd(agentsContent, source.content)
          : agentsContent.includes(LEGACY_AGENTS_TOOLS_GUIDANCE)
            ? ensureLocalNotesHeading(
                agentsContent.replace(LEGACY_AGENTS_TOOLS_GUIDANCE, CURRENT_AGENTS_TOOLS_GUIDANCE),
              )
            : agentsContent;
        if (merged !== agentsContent) {
          await writeAgentsAtomically({ agentsPath, expected: agentsContent, content: merged });
        }
        if (sha256(await fs.readFile(claimPath, "utf8")) !== source.sha256) {
          throw new Error("TOOLS.md changed while the migration claim was held");
        }
        if (merged !== agentsContent && (await fs.readFile(agentsPath, "utf8")) !== merged) {
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
      warnings.push(`Agent "${target.agentId}" TOOLS.md was not migrated: ${errorMessage(error)}`);
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
