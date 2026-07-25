/**
 * Public SDK facade for memory host runtime core and public artifact discovery.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex, sha256HexPrefix } from "../infra/crypto-digest.js";
import { withFileLock } from "../infra/file-lock.js";
import { sameFileIdentity, type FileIdentityStat } from "../infra/fs-safe-advanced.js";
import { FsSafeError, root as createFsSafeRoot } from "../infra/fs-safe.js";
import { syncDirectoryBestEffort } from "../infra/sqlite-snapshot.js";
import {
  MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES,
  serializeMemoryHostEventExport,
} from "../memory-host-sdk/event-export.js";
import { listStoredMemoryHostEvents } from "../memory-host-sdk/event-store.js";
import type { MemoryPluginPublicArtifact } from "../plugins/memory-state.js";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";
import { resolveMemoryDreamingWorkspaces } from "./memory-core-host-status.js";
import {
  isMemoryHostEventArtifactAtIdentity,
  isMissingPathError,
  isRejectedWorkspaceArtifactPath,
  memoryHostEventExportOwnerContent,
  publishMemoryHostEventArtifact,
  rewriteMemoryHostEventArtifactIfUnchanged,
} from "./memory-host-event-export.js";

const MEMORY_HOST_EVENTS_FILENAME = "memory-host-events.jsonl";
const MEMORY_HOST_EVENTS_OWNER_FILENAME = ".openclaw-memory-host-events-owner.json";
const MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS = 1_000;
const MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS = {
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;
const memoryHostEventExportQueue = new KeyedAsyncQueue();

function isWorkspaceWriteUnavailable(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const code = (error as { code?: unknown }).code;
  if (
    code === "EACCES" ||
    code === "EEXIST" ||
    code === "ENOTDIR" ||
    code === "EPERM" ||
    code === "EROFS" ||
    (error instanceof FsSafeError && (code === "not-file" || code === "not-removable"))
  ) {
    return true;
  }
  if (error instanceof FsSafeError && error.category === "policy" && code !== "invalid-path") {
    return false;
  }
  return isWorkspaceWriteUnavailable((error as { cause?: unknown }).cause, seen);
}

async function resolveMemoryHostEventExportOwner(workspaceDir: string): Promise<{
  queueKey: string;
  lockTarget: string;
  relativePath: string;
  ownerRelativePath: string;
  stateHash: string;
  workspaceHash: string;
}> {
  const requestedStateDir = path.resolve(resolveStateDir());
  await fs.mkdir(requestedStateDir, { recursive: true, mode: 0o700 });
  const stateDir = await fs.realpath(requestedStateDir);
  const stateHash = sha256HexPrefix(stateDir, 32);
  const workspaceHash = sha256HexPrefix(path.resolve(workspaceDir), 32);
  const exportDirectory = path.posix.join("memory", "events", stateHash);
  return {
    queueKey: `${stateHash}\0${workspaceHash}`,
    lockTarget: path.join(stateDir, `.memory-host-events-export-${workspaceHash}`),
    relativePath: path.posix.join(exportDirectory, MEMORY_HOST_EVENTS_FILENAME),
    ownerRelativePath: path.posix.join(exportDirectory, MEMORY_HOST_EVENTS_OWNER_FILENAME),
    stateHash,
    workspaceHash,
  };
}

async function readMemoryHostEventExportOwnership(
  workspaceRoot: Awaited<ReturnType<typeof createFsSafeRoot>>,
  owner: Awaited<ReturnType<typeof resolveMemoryHostEventExportOwner>>,
): Promise<
  | {
      kind: "owned";
      content: string | undefined;
      identity: FileIdentityStat;
      ownerContent: string;
      needsFinalize: boolean;
    }
  | { kind: "missing" }
  | { kind: "orphan"; ownerContent: string }
  | { kind: "pending-missing"; ownerContent: string }
  | { kind: "foreign" }
> {
  const content = await workspaceRoot.readText(owner.ownerRelativePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    if (isRejectedWorkspaceArtifactPath(error)) {
      return null;
    }
    throw error;
  });
  if (content === null) {
    return { kind: "foreign" };
  }
  if (content === undefined) {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { kind: "foreign" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 3 ||
    (parsed as { kind?: unknown }).kind !== "openclaw-memory-host-events-export" ||
    (parsed as { stateHash?: unknown }).stateHash !== owner.stateHash ||
    (parsed as { workspaceHash?: unknown }).workspaceHash !== owner.workspaceHash ||
    ((parsed as { contentSha256?: unknown }).contentSha256 !== undefined &&
      typeof (parsed as { contentSha256?: unknown }).contentSha256 !== "string") ||
    ((parsed as { pendingContentSha256?: unknown }).pendingContentSha256 !== undefined &&
      typeof (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 !== "string") ||
    ((parsed as { contentSha256?: unknown }).contentSha256 === undefined &&
      (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 === undefined) ||
    ((parsed as { fileDev?: unknown }).fileDev === undefined) !==
      ((parsed as { fileIno?: unknown }).fileIno === undefined) ||
    ((parsed as { fileDev?: unknown }).fileDev !== undefined &&
      (typeof (parsed as { fileDev?: unknown }).fileDev !== "string" ||
        !/^\d+$/u.test((parsed as { fileDev: string }).fileDev) ||
        typeof (parsed as { fileIno?: unknown }).fileIno !== "string" ||
        !/^\d+$/u.test((parsed as { fileIno: string }).fileIno)))
  ) {
    return { kind: "foreign" };
  }
  const storedIdentity =
    typeof (parsed as { fileDev?: unknown }).fileDev === "string" &&
    typeof (parsed as { fileIno?: unknown }).fileIno === "string"
      ? {
          dev: BigInt((parsed as { fileDev: string }).fileDev),
          ino: BigInt((parsed as { fileIno: string }).fileIno),
        }
      : undefined;
  let openedExport: Awaited<ReturnType<typeof workspaceRoot.open>> | undefined;
  try {
    openedExport = await workspaceRoot.open(owner.relativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      openedExport = undefined;
    } else if (isRejectedWorkspaceArtifactPath(error)) {
      return { kind: "foreign" };
    } else {
      throw error;
    }
  }
  if (!openedExport) {
    return typeof (parsed as { pendingContentSha256?: unknown }).pendingContentSha256 === "string"
      ? { kind: "pending-missing", ownerContent: content }
      : { kind: "orphan", ownerContent: content };
  }
  let exportContent: string;
  const exportIdentity: FileIdentityStat = {
    dev: openedExport.stat.dev,
    ino: openedExport.stat.ino,
  };
  const identityOwned =
    storedIdentity !== undefined && sameFileIdentity(storedIdentity, exportIdentity);
  try {
    if (openedExport.stat.size > MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES) {
      return identityOwned
        ? {
            kind: "owned",
            content: undefined,
            identity: exportIdentity,
            ownerContent: content,
            needsFinalize: true,
          }
        : { kind: "foreign" };
    }
    exportContent = await openedExport.handle.readFile({ encoding: "utf8" });
  } finally {
    await openedExport.handle.close().catch(() => undefined);
  }
  const exportSha256 = sha256Hex(exportContent);
  const currentSha256 = (parsed as { contentSha256?: string }).contentSha256;
  const pendingSha256 = (parsed as { pendingContentSha256?: string }).pendingContentSha256;
  // Hash-only markers never reach the owned branch; only the persisted inode
  // identity authorizes later mutation of this workspace artifact.
  return identityOwned
    ? {
        kind: "owned",
        content: exportContent,
        identity: exportIdentity,
        ownerContent: content,
        needsFinalize: exportSha256 !== currentSha256 || pendingSha256 !== undefined,
      }
    : { kind: "foreign" };
}

export {
  buildMemoryPromptSection as buildActiveMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
} from "../plugins/memory-state.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";
export { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
export { resolveSessionAgentId } from "../agents/agent-scope.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function materializeMemoryHostEventExport(params: {
  workspaceDir: string;
}): Promise<{ absolutePath: string; relativePath: string } | undefined> {
  const requestedWorkspace = path.resolve(params.workspaceDir);
  const workspace = await fs.stat(requestedWorkspace).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!workspace?.isDirectory()) {
    return undefined;
  }
  const workspaceRoot = await createFsSafeRoot(requestedWorkspace, {
    hardlinks: "reject",
    mkdir: true,
    mode: 0o600,
    symlinks: "reject",
  });
  const workspaceKey = workspaceRoot.rootReal;
  const owner = await resolveMemoryHostEventExportOwner(workspaceKey);
  // The queue handles re-entrant calls in this process; the sidecar lock makes
  // snapshot, cleanup, and replacement one ordered operation across processes.
  // State-qualified paths keep different profiles from replacing each other's export.
  return memoryHostEventExportQueue.enqueue(owner.queueKey, async () => {
    const absolutePath = path.join(workspaceKey, ...owner.relativePath.split("/"));
    return await withFileLock(owner.lockTarget, MEMORY_HOST_EVENT_EXPORT_LOCK_OPTIONS, async () => {
      const storedEvents = listStoredMemoryHostEvents({
        workspaceDir: workspaceKey,
        limit: MAX_MEMORY_HOST_PUBLIC_EXPORT_EVENTS,
      });
      const ownership = await readMemoryHostEventExportOwnership(workspaceRoot, owner);
      if (ownership.kind === "foreign") {
        return undefined;
      }
      if (storedEvents.length === 0 && ownership.kind !== "owned") {
        return undefined;
      }
      const content = storedEvents.length > 0 ? serializeMemoryHostEventExport(storedEvents) : "";
      const contentSha256 = sha256Hex(content);
      let publishedIdentity: FileIdentityStat | undefined;
      if (ownership.kind === "missing") {
        const existing = await workspaceRoot
          .readText(owner.relativePath)
          .catch((error: unknown) => {
            if (isMissingPathError(error)) {
              return undefined;
            }
            if (isRejectedWorkspaceArtifactPath(error)) {
              return null;
            }
            throw error;
          });
        if (existing !== undefined) {
          return undefined;
        }
        try {
          const pendingOwnerContent = memoryHostEventExportOwnerContent(owner, {
            pendingSha256: contentSha256,
          });
          await workspaceRoot.create(owner.ownerRelativePath, pendingOwnerContent, {
            mkdir: true,
            mode: 0o600,
          });
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          publishedIdentity = await publishMemoryHostEventArtifact({
            workspaceRoot,
            owner,
            absolutePath,
            expectedOwnerContent: pendingOwnerContent,
            content,
            contentSha256,
          });
          if (!publishedIdentity) {
            return undefined;
          }
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      } else if (ownership.kind === "pending-missing" || ownership.kind === "orphan") {
        try {
          const pendingOwnerContent = memoryHostEventExportOwnerContent(owner, {
            pendingSha256: contentSha256,
          });
          if (
            !(await rewriteMemoryHostEventArtifactIfUnchanged({
              workspaceRoot,
              relativePath: owner.ownerRelativePath,
              expectedContent: ownership.ownerContent,
              nextContent: pendingOwnerContent,
            }))
          ) {
            return undefined;
          }
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          publishedIdentity = await publishMemoryHostEventArtifact({
            workspaceRoot,
            owner,
            absolutePath,
            expectedOwnerContent: pendingOwnerContent,
            content,
            contentSha256,
          });
          if (!publishedIdentity) {
            return undefined;
          }
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      } else if (ownership.content !== content) {
        publishedIdentity = ownership.identity;
        try {
          const updateOwnerContent = memoryHostEventExportOwnerContent(owner, {
            pendingSha256: contentSha256,
            identity: ownership.identity,
            ...(ownership.content === undefined
              ? {}
              : { currentSha256: sha256Hex(ownership.content) }),
          });
          const currentOwnerContent = memoryHostEventExportOwnerContent(owner, {
            currentSha256: contentSha256,
            identity: ownership.identity,
          });
          if (
            !(await rewriteMemoryHostEventArtifactIfUnchanged({
              workspaceRoot,
              relativePath: owner.ownerRelativePath,
              expectedContent: ownership.ownerContent,
              nextContent: updateOwnerContent,
            }))
          ) {
            return undefined;
          }
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          if (
            !(await rewriteMemoryHostEventArtifactIfUnchanged({
              workspaceRoot,
              relativePath: owner.relativePath,
              expectedIdentity: ownership.identity,
              nextContent: content,
            }))
          ) {
            return undefined;
          }
          await syncDirectoryBestEffort(path.dirname(absolutePath));
          if (
            !(await rewriteMemoryHostEventArtifactIfUnchanged({
              workspaceRoot,
              relativePath: owner.ownerRelativePath,
              expectedContent: updateOwnerContent,
              nextContent: currentOwnerContent,
            }))
          ) {
            return undefined;
          }
          await syncDirectoryBestEffort(path.dirname(absolutePath));
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      } else if (ownership.needsFinalize) {
        publishedIdentity = ownership.identity;
        try {
          if (
            !(await rewriteMemoryHostEventArtifactIfUnchanged({
              workspaceRoot,
              relativePath: owner.ownerRelativePath,
              expectedContent: ownership.ownerContent,
              nextContent: memoryHostEventExportOwnerContent(owner, {
                currentSha256: contentSha256,
                identity: ownership.identity,
              }),
            }))
          ) {
            return undefined;
          }
          await syncDirectoryBestEffort(path.dirname(absolutePath));
        } catch (error) {
          if (isWorkspaceWriteUnavailable(error)) {
            return undefined;
          }
          throw error;
        }
      } else {
        publishedIdentity = ownership.identity;
      }
      if (storedEvents.length === 0 || !publishedIdentity) {
        return undefined;
      }
      return (await isMemoryHostEventArtifactAtIdentity({
        workspaceRoot,
        relativePath: owner.relativePath,
        expectedIdentity: publishedIdentity,
        expectedContent: content,
      }))
        ? { absolutePath, relativePath: owner.relativePath }
        : undefined;
    });
  });
}

/** Lists public memory artifacts for one workspace, including notes and event logs. */
async function listMemoryWorkspacePublicArtifacts(params: {
  workspaceDir: string;
  agentIds: string[];
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts: MemoryPluginPublicArtifact[] = [];
  const workspaceEntries = new Set(
    (await fs.readdir(params.workspaceDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  if (workspaceEntries.has("MEMORY.md")) {
    const absolutePath = path.join(params.workspaceDir, "MEMORY.md");
    artifacts.push({
      kind: "memory-root",
      workspaceDir: params.workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const memoryDir = path.join(params.workspaceDir, "memory");
  for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
    const relativePath = path.relative(params.workspaceDir, absolutePath).replace(/\\/g, "/");
    artifacts.push({
      kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
      workspaceDir: params.workspaceDir,
      relativePath,
      absolutePath,
      agentIds: [...params.agentIds],
      contentType: "markdown",
    });
  }

  const eventExport = await materializeMemoryHostEventExport({
    workspaceDir: params.workspaceDir,
  });
  if (eventExport) {
    artifacts.push({
      kind: "event-log",
      workspaceDir: params.workspaceDir,
      relativePath: eventExport.relativePath,
      absolutePath: eventExport.absolutePath,
      agentIds: [...params.agentIds],
      contentType: "json",
    });
  }

  const deduped = new Map<string, MemoryPluginPublicArtifact>();
  for (const artifact of artifacts) {
    deduped.set(`${artifact.workspaceDir}\0${artifact.relativePath}\0${artifact.kind}`, artifact);
  }
  return [...deduped.values()];
}

/** Lists public memory artifacts across all configured memory workspaces. */
export async function listMemoryHostPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    artifacts.push(
      ...(await listMemoryWorkspacePublicArtifacts({
        workspaceDir: workspace.workspaceDir,
        agentIds: workspace.agentIds,
      })),
    );
  }
  return artifacts;
}
