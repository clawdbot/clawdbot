/** Filesystem-safe TOOLS.md claim, archive, and sibling AGENTS.md writes. */
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME } from "../agents/workspace.js";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  mergeToolsMdIntoAgentsMd,
  normalizeAgentsToolsGuidance,
  shouldMergeToolsMdContent,
} from "./doctor-tools-md-content.js";

export const TOOLS_CLAIM_INFIX = ".doctor-importing-";
const ACTIVE_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;
const HARD_LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

export type ToolsMdSource = {
  path: string;
  content: string;
  sha256: string;
  fromExtraPattern?: boolean;
};

type MigrationClaimIdentity = {
  ownerPid: number;
  createdAtMs: number;
};

type MigrationFileSnapshot = {
  content: string;
  stat?: syncFs.Stats;
};

export function sha256(content: string): string {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readToolsMd(
  workspaceDir: string,
  options?: { recoverClaims?: boolean },
): Promise<ToolsMdSource | undefined> {
  const toolsPath = path.join(workspaceDir, DEFAULT_TOOLS_FILENAME);
  let stat;
  try {
    stat = await fs.lstat(toolsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
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
      : normalizeAgentsToolsGuidance(claimedContent);
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
}): Promise<void> {
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
}

async function resolveAgentsMigrationDestination(params: {
  workspaceDir: string;
  sourceDir: string;
}): Promise<string> {
  const [workspaceRealPath, sourceDirRealPath] = await Promise.all([
    fs.realpath(params.workspaceDir),
    fs.realpath(params.sourceDir),
  ]);
  if (!isPathInside(workspaceRealPath, sourceDirRealPath)) {
    throw new Error(
      `AGENTS.md migration destination resolves outside the workspace: ${sourceDirRealPath}`,
    );
  }
  const agentsPath = path.join(sourceDirRealPath, DEFAULT_AGENTS_FILENAME);
  await readMigrationFileSnapshot({ filePath: agentsPath, label: "AGENTS.md", allowMissing: true });
  return agentsPath;
}

export async function migrateToolsMdSource(params: {
  agentId: string;
  source: ToolsMdSource;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ shouldMerge: boolean; agentsPath: string }> {
  const shouldMerge = shouldMergeToolsMdContent(params.source.content);
  const sourceDir = path.dirname(params.source.path);
  const agentsPath = await resolveAgentsMigrationDestination({
    workspaceDir: params.workspaceDir,
    sourceDir,
  });
  await archiveSource({ agentId: params.agentId, source: params.source, env: params.env });
  const claimPath = `${params.source.path}${TOOLS_CLAIM_INFIX}${process.pid}-${Date.now()}-${params.source.sha256.slice(0, 12)}`;
  await fs.rename(params.source.path, claimPath);
  try {
    if (sha256(await fs.readFile(claimPath, "utf8")) !== params.source.sha256) {
      throw new Error("TOOLS.md changed before the migration claim was acquired");
    }
    await recoverInterruptedAgentsClaim({
      agentsPath,
      toolsContent: params.source.content,
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
      ? mergeToolsMdIntoAgentsMd(agentsContent, params.source.content)
      : normalizeAgentsToolsGuidance(agentsContent);
    if (merged !== agentsContent) {
      await writeAgentsAtomically({ agentsPath, expected: agentsContent, content: merged });
    }
    if (sha256(await fs.readFile(claimPath, "utf8")) !== params.source.sha256) {
      throw new Error("TOOLS.md changed while the migration claim was held");
    }
    if (
      merged !== agentsContent &&
      (await readMigrationFileSnapshot({ filePath: agentsPath, label: "AGENTS.md" })).content !==
        merged
    ) {
      throw new Error("AGENTS.md changed after TOOLS.md migration was written");
    }
    await fs.rm(claimPath);
    await syncDirectory(sourceDir);
  } catch (error) {
    try {
      await restoreClaimNoClobber(claimPath, params.source.path);
    } catch (restoreError) {
      throw new Error(`TOOLS.md migration claim is preserved at ${claimPath}`, {
        cause: restoreError,
      });
    }
    throw error;
  }
  return { shouldMerge, agentsPath };
}
