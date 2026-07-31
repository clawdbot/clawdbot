import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isUsageCountedSessionTranscriptFileName } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  defaultRuntime,
  formatErrorMessage,
  getMemorySearchManager,
  getRuntimeConfig,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  resolveCommandSecretRefsViaGateway,
  resolveDefaultAgentId,
  resolveSessionTranscriptsDirForAgent,
  shortenHomePath,
  theme,
  type OpenClawConfig,
  withManager,
} from "./cli.host.runtime.js";
import { asRecord } from "./dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import type { ShortTermAuditSummary } from "./short-term-promotion.js";
const { warn } = theme;
export type MemoryManager = NonNullable<
  Awaited<ReturnType<typeof getMemorySearchManager>>["manager"]
>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];
function getMemoryCommandSecretTargetIds(): Set<string> {
  return new Set(["memory.search.remote.apiKey", "agents.entries.*.memory.search.remote.apiKey"]);
}
function isMemorySecretOwnerFailure(error: unknown, message: string): boolean {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (
    candidate.ownerKind === "capability" &&
    typeof candidate.ownerId === "string" &&
    candidate.ownerId.startsWith("memory-provider:")
  ) {
    return true;
  }
  if (
    Array.isArray(candidate.paths) &&
    candidate.paths.some(
      (entry) => typeof entry === "string" && entry.includes("memory.search.remote.apiKey"),
    )
  ) {
    return true;
  }
  // Gateway RPC errors preserve the typed owner's redacted message even when
  // structured owner fields are unavailable to the CLI process.
  return message.includes("capability:memory-provider:");
}
async function loadMemoryCommandConfig(
  commandName: string,
  mode?: "enforce_resolved" | "read_only_status",
) {
  const config = getRuntimeConfig();
  try {
    const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
      config,
      commandName,
      targetIds: getMemoryCommandSecretTargetIds(),
      ...(mode ? { mode } : {}),
    });
    return { config: resolvedConfig, diagnostics };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    const message = formatErrorMessage(error);
    if (
      mode !== "read_only_status" ||
      isMemorySecretOwnerFailure(error, message) ||
      (code !== "SECRET_SURFACE_UNAVAILABLE" && !message.includes("SECRET_SURFACE_UNAVAILABLE"))
    ) {
      throw error;
    }
    return {
      config,
      diagnostics: [
        `${commandName}: ${message}; continuing with degraded read-only config so healthy memory surfaces remain visible.`,
      ],
    };
  }
}
function emitMemorySecretResolveDiagnostics(
  diagnostics: string[],
  params?: { json?: boolean },
): void {
  if (diagnostics.length === 0) {
    return;
  }
  const toStderr = params?.json === true;
  for (const entry of diagnostics) {
    const message = warn(`[secrets] ${entry}`);
    if (toStderr) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(message);
    }
  }
}
export function resolveMemoryPluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}
export function formatAuditCounts(audit: ShortTermAuditSummary): string {
  const scriptCoverage = audit.conceptTagScripts
    ? [
        audit.conceptTagScripts.latinEntryCount > 0
          ? `${audit.conceptTagScripts.latinEntryCount} latin`
          : null,
        audit.conceptTagScripts.cjkEntryCount > 0
          ? `${audit.conceptTagScripts.cjkEntryCount} cjk`
          : null,
        audit.conceptTagScripts.mixedEntryCount > 0
          ? `${audit.conceptTagScripts.mixedEntryCount} mixed`
          : null,
        audit.conceptTagScripts.otherEntryCount > 0
          ? `${audit.conceptTagScripts.otherEntryCount} other`
          : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const suffix = scriptCoverage ? ` · scripts=${scriptCoverage}` : "";
  return `${audit.entryCount} entries · ${audit.promotedCount} promoted · ${audit.conceptTaggedEntryCount} concept-tagged · ${audit.spacedEntryCount} spaced${suffix}`;
}
function resolveAgent(cfg: OpenClawConfig, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}
export function buildCliMemorySearchSessionKey(agentId: string): string {
  return buildAgentSessionKey({
    agentId,
    channel: "cli",
    peer: { kind: "direct", id: "memory-search" },
    dmScope: "per-channel-peer",
  });
}
function resolveAgentIds(cfg: OpenClawConfig, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}
export function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}
async function withMemoryManagerForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  if (params.acquireLocalService) {
    managerParams.acquireLocalService = params.acquireLocalService;
  }
  if (params.withLease) {
    managerParams.withLease = params.withLease;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}
export async function withMemoryCommand(params: {
  commandName: string;
  agent?: string;
  allAgents?: boolean;
  diagnosticsToStderr?: boolean;
  purpose?: MemoryManagerPurpose;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
  run: (context: { manager: MemoryManager; cfg: OpenClawConfig; agentId: string }) => Promise<void>;
}): Promise<OpenClawConfig> {
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig(
    params.commandName,
    params.purpose === "status" ? "read_only_status" : undefined,
  );
  emitMemorySecretResolveDiagnostics(diagnostics, { json: params.diagnosticsToStderr });
  const agentIds = params.allAgents
    ? resolveAgentIds(cfg, params.agent)
    : [resolveAgent(cfg, params.agent)];
  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: params.purpose,
      acquireLocalService: params.acquireLocalService,
      withLease: params.withLease,
      run: async (manager) => params.run({ manager, cfg, agentId }),
    });
  }
  return cfg;
}
export type MemorySourceName = "memory" | "sessions";
type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};
export type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};
async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}
async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}
async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const memoryDir = path.join(workspaceDir, "memory");
  const primary = await checkReadableFile(memoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }
  let dirReadable: boolean | null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }
  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }
  let totalFiles: number | null;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
    }
    totalFiles = files.size;
  }
  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }
  return { source: "memory", totalFiles, issues };
}
export async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}
