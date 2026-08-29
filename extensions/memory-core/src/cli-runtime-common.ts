import {
  normalizeExtraMemoryPathEntries,
  type MemoryExtraPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  listAgentIds,
  resolveConfiguredAgentId,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultRuntime,
  formatErrorMessage,
  getMemorySearchManager,
  getRuntimeConfig,
  resolveCommandSecretRefsViaGateway,
  resolveDefaultAgentId,
  shortenHomePath,
  theme,
  type OpenClawConfig,
  withManager,
} from "./cli.host.runtime.js";
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
  const config = getRuntimeConfig({ skipPluginValidation: true });
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
  const entry = asNullableRecord(cfg.plugins?.entries?.["memory-core"]);
  return asNullableRecord(entry?.config) ?? {};
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
export function resolveMemoryAgent(cfg: OpenClawConfig, agent?: string) {
  const trimmed = agent?.trim();
  if (agent !== undefined && !trimmed) {
    throw new Error("--agent must not be blank");
  }
  return trimmed ? resolveConfiguredAgentId(cfg, trimmed) : resolveDefaultAgentId(cfg);
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
  if (agent !== undefined && !trimmed) {
    throw new Error("--agent must not be blank");
  }
  return trimmed ? [resolveConfiguredAgentId(cfg, trimmed)] : listAgentIds(cfg);
}
export function formatExtraPaths(workspaceDir: string, extraPaths: MemoryExtraPath[]): string[] {
  return normalizeExtraMemoryPathEntries(workspaceDir, extraPaths).map((entry) => {
    const root = shortenHomePath(entry.path);
    return entry.pattern ? `${root} (pattern: ${entry.pattern})` : root;
  });
}
async function withMemoryManagerForAgent(params: {
  commandName: string;
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  if (params.inspectSources) {
    managerParams.inspectSources = true;
  }
  if (params.acquireLocalService) {
    managerParams.acquireLocalService = params.acquireLocalService;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => {
      if (!error?.trim()) {
        defaultRuntime.log("Memory search disabled.");
        return;
      }
      defaultRuntime.error(`${params.commandName} failed (${params.agentId}): ${error}`);
      process.exitCode = 1;
    },
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
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  run: (context: { manager: MemoryManager; cfg: OpenClawConfig; agentId: string }) => Promise<void>;
}): Promise<OpenClawConfig> {
  const { config: cfg, diagnostics } = await loadMemoryCommandConfig(
    params.commandName,
    params.purpose === "status" ? "read_only_status" : undefined,
  );
  emitMemorySecretResolveDiagnostics(diagnostics, { json: params.diagnosticsToStderr });
  const agentIds = params.allAgents
    ? resolveAgentIds(cfg, params.agent)
    : [resolveMemoryAgent(cfg, params.agent)];
  for (const agentId of agentIds) {
    await withMemoryManagerForAgent({
      commandName: params.commandName,
      cfg,
      agentId,
      purpose: params.purpose,
      inspectSources: params.inspectSources,
      acquireLocalService: params.acquireLocalService,
      run: async (manager) => params.run({ manager, cfg, agentId }),
    });
  }
  return cfg;
}
type SourceScan = {
  source: "memory" | "sessions";
  totalFiles: number | null;
  issues: string[];
};
export type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};
export async function scanMemoryManagerSources(
  status: ReturnType<MemoryManager["status"]>,
): Promise<MemorySourceScan | undefined> {
  if (!status.sourceCounts?.length) {
    return undefined;
  }
  const sources = status.sourceCounts.map(
    (entry): SourceScan => ({
      source: entry.source,
      totalFiles: entry.eligible ?? null,
      issues: entry.issues ?? [],
    }),
  );
  const totalFiles = sources.some((entry) => entry.totalFiles === null)
    ? null
    : sources.reduce((total, entry) => total + (entry.totalFiles ?? 0), 0);
  return { sources, totalFiles, issues: sources.flatMap((entry) => entry.issues) };
}

export function formatMemoryIndexOutcome(
  status: ReturnType<MemoryManager["status"]>,
  scan: MemorySourceScan | undefined,
  agentId: string,
): string {
  const indexedFiles = status.files ?? 0;
  if (indexedFiles === 0 && status.workspaceDir && scan?.totalFiles === 0) {
    return `No memory files found in ${shortenHomePath(status.workspaceDir)}; nothing indexed (${agentId}).`;
  }
  const fileLabel = indexedFiles === 1 ? "file" : "files";
  return `Memory index updated (${agentId}): ${indexedFiles} ${fileLabel} indexed.`;
}
