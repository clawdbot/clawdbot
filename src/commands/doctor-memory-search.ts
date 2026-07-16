import fsSync from "node:fs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { formatByteSize } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
} from "../agents/auth-profiles.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import {
  resolveApiKeyForProvider,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorMemoryEmbeddingRuntimePayload } from "../gateway/server-methods/doctor.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason,
} from "../memory-host-sdk/engine-qmd.js";
import { hasConfiguredMemorySecretInput } from "../memory-host-sdk/secret.js";
import {
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
  type DreamingArtifactsAuditSummary,
  type ShortTermAuditSummary,
} from "../plugin-sdk/memory-core-engine-runtime.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { resolveUserPath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairWorkspaceMemoryHealth, noteWorkspaceMemoryHealth } from "./doctor-workspace.js";
import { isRecord } from "./doctor/shared/legacy-config-record-shared.js";

type RuntimeMemoryAuditContext = {
  workspaceDir?: string;
  backend?: string;
  dbPath?: string;
  qmdCollections?: number;
};

type MemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

function formatRuntimeBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value >= 10 ? 0 : 1),
  });
}

function formatLocalRuntimeDoctorNote(facts: DoctorMemoryEmbeddingRuntimePayload): string {
  const backend = facts.backend ?? "unknown";
  const build = facts.buildType ? `, ${facts.buildType}` : "";
  const devices = facts.deviceNames?.length ? `\nDevices: ${facts.deviceNames.join(", ")}` : "";
  const memory = facts.memory
    ? `\nVRAM snapshot: ${formatRuntimeBytes(facts.memory.usedBytes)} used, ${formatRuntimeBytes(facts.memory.freeBytes)} free, ${formatRuntimeBytes(facts.memory.totalBytes)} total${
        facts.memory.unifiedBytes > 0
          ? `, ${formatRuntimeBytes(facts.memory.unifiedBytes)} unified`
          : ""
      } (${new Date(facts.memory.observedAtMs).toISOString()})`
    : "";
  const offload =
    typeof facts.offload?.offloadedLayers === "number" &&
    typeof facts.offload.totalLayers === "number"
      ? `\nGPU offload: ${facts.offload.offloadedLayers}/${facts.offload.totalLayers} layers`
      : facts.offload
        ? `\nGPU offload: ${facts.offload.supported ? "supported" : "unsupported"}`
        : "";
  const context = facts.context ? `\nRequested context: ${facts.context.requestedSize} tokens` : "";
  const loadError = facts.loadError ? `\nLoad error: ${facts.loadError}` : "";
  const state = facts.state === "ready" ? "" : ` (${facts.state})`;
  return `llama.cpp runtime: ${backend}${build}${state}${devices}${memory}${offload}${context}${loadError}`;
}

const BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA: MemoryEmbeddingProviderDoctorMetadata[] = [
  {
    providerId: "github-copilot",
    authProviderId: "github-copilot",
    transport: "remote",
    autoSelectPriority: 15,
  },
  {
    providerId: "openai",
    authProviderId: "openai",
    transport: "remote",
    autoSelectPriority: 20,
  },
  {
    providerId: "gemini",
    authProviderId: "google",
    transport: "remote",
    autoSelectPriority: 30,
  },
  {
    providerId: "voyage",
    authProviderId: "voyage",
    transport: "remote",
    autoSelectPriority: 40,
  },
  {
    providerId: "mistral",
    authProviderId: "mistral",
    transport: "remote",
    autoSelectPriority: 50,
  },
  {
    providerId: "bedrock",
    authProviderId: "amazon-bedrock",
    transport: "remote",
    autoSelectPriority: 60,
  },
];
const DEFAULT_MEMORY_EMBEDDING_PROVIDER = "openai";
const OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER = "openai-compatible";
const OPENAI_COMPATIBLE_MODEL_APIS = new Set(["openai-completions", "openai-responses"]);

function resolveMemoryEmbeddingProviderDoctorMetadata(
  providerId: string,
): (MemoryEmbeddingProviderDoctorMetadata & { envVars: string[] }) | null {
  const metadata =
    BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA.find(
      (candidate) => candidate.providerId === providerId,
    ) ?? null;
  if (!metadata) {
    return null;
  }
  return {
    ...metadata,
    envVars: getProviderEnvVars(metadata.authProviderId),
  };
}

function listAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<
  MemoryEmbeddingProviderDoctorMetadata & { envVars: string[] }
> {
  return BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA.filter(
    (provider) => typeof provider.autoSelectPriority === "number",
  )
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((provider) => ({
      providerId: provider.providerId,
      authProviderId: provider.authProviderId,
      transport: provider.transport,
      autoSelectPriority: provider.autoSelectPriority,
      envVars: getProviderEnvVars(provider.authProviderId),
    }));
}

function resolveSuggestedRemoteMemoryProvider(): string | undefined {
  return listAutoSelectMemoryEmbeddingProviderDoctorMetadata().find(
    (provider) => provider.transport === "remote",
  )?.providerId;
}

function hasConfiguredAwsSdkAuthForProvider(provider: string, cfg: OpenClawConfig): boolean {
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, provider);
  if (providerConfig?.auth === "aws-sdk") {
    return true;
  }
  const orderedProfileIds = findNormalizedProviderValue(cfg.auth?.order, provider);
  const profileIds =
    orderedProfileIds ?? (cfg.auth?.profiles ? Object.keys(cfg.auth.profiles) : []);
  return profileIds.some((profileId) =>
    isConfiguredAwsSdkAuthProfileForProvider({ cfg, provider, profileId }),
  );
}

function isOpenAICompatibleMemoryProvider(providerId: string, cfg: OpenClawConfig): boolean {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (normalizedProviderId === OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER) {
    return true;
  }
  if (
    BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA.some(
      (provider) => provider.providerId === normalizedProviderId,
    )
  ) {
    return false;
  }
  const providerConfig = findNormalizedProviderValue(cfg.models?.providers, providerId);
  if (!providerConfig) {
    return false;
  }
  const api = normalizeProviderId(providerConfig.api ?? "");
  if (
    api === OPENAI_COMPATIBLE_MEMORY_EMBEDDING_PROVIDER ||
    OPENAI_COMPATIBLE_MODEL_APIS.has(api)
  ) {
    return true;
  }
  return !api && Boolean(normalizeOptionalString(providerConfig.baseUrl));
}

function resolveOpenAICompatibleMemoryBaseUrl(
  providerId: string,
  cfg: OpenClawConfig,
  remoteBaseUrl: string | undefined,
): string | undefined {
  return (
    normalizeOptionalString(remoteBaseUrl) ??
    normalizeOptionalString(findNormalizedProviderValue(cfg.models?.providers, providerId)?.baseUrl)
  );
}

function isKeyOptionalMemoryProvider(providerId: string, cfg: OpenClawConfig): boolean {
  return (
    providerId === "local" ||
    providerId === "ollama" ||
    providerId === "lmstudio" ||
    isOpenAICompatibleMemoryProvider(providerId, cfg)
  );
}

async function resolveRuntimeMemoryAuditContext(
  cfg: OpenClawConfig,
): Promise<RuntimeMemoryAuditContext | null> {
  const agentId = resolveDefaultAgentId(cfg);
  const result = await getActiveMemorySearchManager({
    cfg,
    agentId,
    purpose: "status",
  });
  const manager = result.manager;
  if (!manager) {
    return null;
  }
  try {
    const status = manager.status();
    const customQmd =
      isRecord(status.custom) && isRecord(status.custom.qmd) ? status.custom.qmd : null;
    return {
      workspaceDir: status.workspaceDir?.trim(),
      backend: status.backend,
      dbPath: status.dbPath,
      qmdCollections:
        typeof customQmd?.collections === "number" ? customQmd.collections : undefined,
    };
  } finally {
    await manager.close?.().catch(() => undefined);
  }
}

function buildMemoryRecallIssueNote(audit: ShortTermAuditSummary): string | null {
  if (audit.issues.length === 0) {
    return null;
  }
  const issueLines = audit.issues.map((issue) => `- ${issue.message}`);
  const hasFixableIssue = audit.issues.some((issue) => issue.fixable);
  const guidance = hasFixableIssue
    ? `Fix: ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw memory status --fix")}`
    : `Verify: ${formatCliCommand("openclaw memory status --deep")}`;
  return [
    "Memory recall artifacts need attention:",
    ...issueLines,
    `Recall store: ${audit.storePath}`,
    guidance,
  ].join("\n");
}

function buildDreamingArtifactIssueNote(audit: DreamingArtifactsAuditSummary): string | null {
  if (audit.issues.length === 0) {
    return null;
  }
  const issueLines = audit.issues.map((issue) => `- ${issue.message}`);
  const hasFixableIssue = audit.issues.some((issue) => issue.fixable);
  return [
    "Dreaming artifacts need attention:",
    ...issueLines,
    `Dream corpus: ${audit.sessionCorpusDir}`,
    hasFixableIssue
      ? `Fix: ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw memory status --fix")}`
      : `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
  ].join("\n");
}

export async function noteMemoryRecallHealth(cfg: OpenClawConfig): Promise<void> {
  try {
    const context = await resolveRuntimeMemoryAuditContext(cfg);
    const workspaceDir = context?.workspaceDir?.trim();
    if (!workspaceDir) {
      return;
    }
    const audit = await auditShortTermPromotionArtifacts({
      workspaceDir,
      qmd:
        context?.backend === "qmd"
          ? {
              dbPath: context.dbPath,
              collections: context.qmdCollections,
            }
          : undefined,
    });
    const message = buildMemoryRecallIssueNote(audit);
    if (message) {
      note(message, "Memory search");
    }
    const dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
    const dreamingMessage = buildDreamingArtifactIssueNote(dreamingAudit);
    if (dreamingMessage) {
      note(dreamingMessage, "Memory search");
    }
  } catch (err) {
    note(`Memory recall audit could not be completed: ${formatErrorMessage(err)}`, "Memory search");
  }
}

export async function maybeRepairMemoryRecallHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  await maybeRepairWorkspaceMemoryHealth(params);

  try {
    const context = await resolveRuntimeMemoryAuditContext(params.cfg);
    const workspaceDir = context?.workspaceDir?.trim();
    if (!workspaceDir) {
      return;
    }
    const audit = await auditShortTermPromotionArtifacts({
      workspaceDir,
      qmd:
        context?.backend === "qmd"
          ? {
              dbPath: context.dbPath,
              collections: context.qmdCollections,
            }
          : undefined,
    });
    const hasFixableRecallIssue = audit.issues.some((issue) => issue.fixable);
    if (hasFixableRecallIssue) {
      const approved = await params.prompter.confirmRuntimeRepair({
        message: "Normalize memory recall artifacts and remove stale promotion locks?",
        initialValue: true,
      });
      if (approved) {
        const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
        if (repair.changed) {
          const removedOverflowEntries = repair.removedOverflowEntries ?? 0;
          const details = [
            repair.removedInvalidEntries > 0
              ? `-${repair.removedInvalidEntries} invalid entries`
              : null,
            removedOverflowEntries > 0 ? `-${removedOverflowEntries} overflow entries` : null,
          ]
            .filter(Boolean)
            .join(", ");
          const lines = [
            "Memory recall artifacts repaired:",
            repair.rewroteStore ? `- rewrote recall store${details ? ` (${details})` : ""}` : null,
            repair.removedStaleLock ? "- removed stale promotion lock" : null,
            `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
          ].filter(Boolean);
          note(lines.join("\n"), "Doctor changes");
        }
      }
    }

    const dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
    const hasFixableDreamingIssue = dreamingAudit.issues.some((issue) => issue.fixable);
    if (!hasFixableDreamingIssue) {
      return;
    }
    const approvedDreamingRepair = await params.prompter.confirmRuntimeRepair({
      message: "Archive contaminated dreaming artifacts and reset derived dream corpus state?",
      initialValue: true,
    });
    if (!approvedDreamingRepair) {
      return;
    }
    const dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
    if (!dreamingRepair.changed) {
      return;
    }
    const lines = [
      "Dreaming artifacts repaired:",
      dreamingRepair.archivedSessionCorpus ? "- archived session corpus" : null,
      dreamingRepair.archivedSessionIngestion ? "- archived session-ingestion state" : null,
      dreamingRepair.archivedDreamsDiary ? "- archived dream diary" : null,
      dreamingRepair.archiveDir ? `- archive dir: ${dreamingRepair.archiveDir}` : null,
      ...dreamingRepair.warnings.map((warning) => `- warning: ${warning}`),
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].filter(Boolean);
    note(lines.join("\n"), "Doctor changes");
  } catch (err) {
    note(
      `Memory artifact repair could not be completed: ${formatErrorMessage(err)}`,
      "Memory search",
    );
  }
}

function hasActiveAlternateMemoryPluginSlot(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled) {
    return false;
  }
  const memorySlot = plugins.slots.memory;
  if (typeof memorySlot !== "string" || memorySlot.length === 0) {
    return false;
  }
  if (memorySlot === defaultSlotIdForKey("memory")) {
    return false;
  }
  if (plugins.deny.includes(memorySlot)) {
    return false;
  }
  if (!Object.hasOwn(plugins.entries, memorySlot)) {
    return false;
  }
  const entry = plugins.entries[memorySlot];
  if (!entry || entry.enabled === false) {
    return false;
  }
  return entry.enabled === true || entry.config !== undefined;
}

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` — config-only checks where possible;
 * may spawn a short-lived probe process when `memory.backend=qmd` to verify
 * the configured `qmd` binary is available.
 */
export async function noteMemorySearchHealth(
  cfg: OpenClawConfig,
  opts?: {
    gatewayMemoryProbe?: {
      checked: boolean;
      ready: boolean;
      error?: string;
      skipped?: boolean;
      runtimeFacts?: DoctorMemoryEmbeddingRuntimePayload;
    };
    noteFn?: typeof note;
    includeWorkspaceMemoryHealth?: boolean;
    skipQmdBinaryProbe?: boolean;
    skipAuthProfileResolution?: boolean;
  },
): Promise<void> {
  const noteFn = opts?.noteFn ?? note;
  if (opts?.includeWorkspaceMemoryHealth !== false) {
    await noteWorkspaceMemoryHealth(cfg);
  }

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved?.remote?.apiKey);

  if (!resolved) {
    noteFn("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }
  const provider =
    resolved.provider === "auto" ? DEFAULT_MEMORY_EMBEDDING_PROVIDER : resolved.provider;

  // QMD backend handles embeddings internally (e.g. embeddinggemma) — no
  // separate embedding provider is needed. Skip the provider check entirely.
  const backendConfig = resolveActiveMemoryBackendConfig({ cfg, agentId });
  if (!backendConfig) {
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      return;
    }
    if (hasActiveAlternateMemoryPluginSlot(cfg)) {
      return;
    }
    noteFn("No active memory plugin is registered for the current config.", "Memory search");
    return;
  }
  if (backendConfig.backend === "qmd") {
    if (opts?.skipQmdBinaryProbe !== true) {
      const qmdCheck = await checkQmdBinaryAvailability({
        command: backendConfig.qmd?.command ?? "qmd",
        env: process.env,
        cwd: resolveAgentWorkspaceDir(cfg, agentId),
      });
      if (!qmdCheck.available) {
        const workspaceProbeFailed =
          resolveQmdBinaryUnavailableReason(qmdCheck) === "workspace-cwd";
        const probeError = qmdCheck.error.trim();
        noteFn(
          [
            workspaceProbeFailed
              ? "QMD memory backend is configured, but the agent workspace directory could not be used for the QMD startup probe."
              : `QMD memory backend is configured, but the qmd binary could not be started (${backendConfig.qmd?.command ?? "qmd"}).`,
            probeError ? `Probe error: ${probeError}` : null,
            "",
            "Fix (pick one):",
            workspaceProbeFailed
              ? "- Create the missing workspace directory or update the agent workspace path to an existing directory."
              : "- Install the supported QMD package: npm install -g @tobilu/qmd (or bun install -g @tobilu/qmd)",
            workspaceProbeFailed
              ? "- Verify the resolved workspace path for the affected agent before retrying."
              : `- Set an explicit binary path: ${formatCliCommand("openclaw config set memory.qmd.command /absolute/path/to/qmd")}`,
            `- Or switch back to builtin memory: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
            "",
            `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
          ]
            .filter(Boolean)
            .join("\n"),
          "Memory search",
        );
      }
    }
    if (resolved.sources?.includes("sessions") && cfg.memory?.qmd?.sessions?.enabled !== true) {
      noteFn(
        [
          "QMD memory backend is configured and the default agent resolves memorySearch.sources with sessions,",
          "but QMD session transcript export is not enabled (memory.qmd.sessions.enabled is not true).",
          "Session transcript hits will not appear in QMD-backed memory search until QMD session export is enabled.",
          "",
          "Fix (pick one):",
          `- Enable QMD session export: ${formatCliCommand(
            "openclaw config set memory.qmd.sessions.enabled true",
          )}`,
          "- Or remove sessions from the default agent's memorySearch.sources if QMD session recall is not intended.",
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
    }
    return;
  }

  if (provider === "none") {
    return;
  }

  if (provider === "local") {
    const suggestedRemoteProvider = resolveSuggestedRemoteMemoryProvider();
    const runtimeFacts = opts?.gatewayMemoryProbe?.runtimeFacts;
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      if (runtimeFacts) {
        noteFn(formatLocalRuntimeDoctorNote(runtimeFacts), "Memory search");
      }
      return;
    }
    const hasExplicitLocalModel = hasLocalEmbeddings(resolved.local);
    const hasUnavailableConfiguredLocalModel =
      Boolean(normalizeOptionalString(resolved.local.modelPath)) && !hasExplicitLocalModel;
    if (opts?.gatewayMemoryProbe?.skipped && !hasUnavailableConfiguredLocalModel) {
      return;
    }
    const detail = opts?.gatewayMemoryProbe?.error?.trim();
    const gatewayDetail = detail && detail !== runtimeFacts?.loadError ? detail : null;
    noteFn(
      [
        runtimeFacts ? formatLocalRuntimeDoctorNote(runtimeFacts) : null,
        runtimeFacts ? "" : null,
        hasExplicitLocalModel
          ? 'Memory search provider is set to "local" and a local model path is configured, but local embeddings are not confirmed ready.'
          : 'Memory search provider is set to "local", but local embeddings are not confirmed ready.',
        gatewayDetail ? `Gateway probe: ${gatewayDetail}` : null,
        "",
        "Fix (pick one):",
        `- Install the llama.cpp provider plugin: ${formatCliCommand("openclaw plugins install @openclaw/llama-cpp-provider")}`,
        `- Set a local GGUF model path in config`,
        suggestedRemoteProvider
          ? `- Switch to a remote provider: ${formatCliCommand(`openclaw config set agents.defaults.memorySearch.provider ${suggestedRemoteProvider}`)}`
          : `- Switch to a remote embedding provider in config`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Memory search",
    );
    return;
  }

  if (
    isOpenAICompatibleMemoryProvider(provider, cfg) &&
    !resolveOpenAICompatibleMemoryBaseUrl(provider, cfg, resolved.remote?.baseUrl)
  ) {
    noteFn(
      [
        `Memory search provider is set to "${provider}" but no OpenAI-compatible embeddings endpoint was configured.`,
        "Set agents.defaults.memorySearch.remote.baseUrl to the /v1 endpoint for your embeddings server.",
        "",
        "Fix:",
        `- ${formatCliCommand("openclaw config set agents.defaults.memorySearch.remote.baseUrl http://127.0.0.1:1234/v1")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  if (isOpenAICompatibleMemoryProvider(provider, cfg) && !normalizeOptionalString(resolved.model)) {
    noteFn(
      [
        `Memory search provider is set to "${provider}" but no OpenAI-compatible embedding model was configured.`,
        "Set agents.defaults.memorySearch.model to the embedding model id your server expects.",
        "",
        "Fix:",
        `- ${formatCliCommand("openclaw config set agents.defaults.memorySearch.model text-embedding-bge-m3")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  if (isKeyOptionalMemoryProvider(provider, cfg)) {
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      return;
    }
    // When the probe was intentionally skipped (skipped: true / checked: false
    // due to probe:false path), we have no embedding status information — do
    // not warn. A skipped probe means the user ran `openclaw doctor` without
    // --deep; it does not mean embeddings are unavailable.
    // NOTE: a transport timeout also sets checked: false, but skipped stays
    // false/absent — a timeout is a real diagnostic signal and should fall
    // through to the warning below.
    if (opts?.gatewayMemoryProbe?.skipped) {
      return;
    }
    const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
    noteFn(
      [
        gatewayProbeWarning
          ? `Memory search provider "${provider}" is configured, but the gateway reports embeddings are not ready.`
          : `Memory search provider "${provider}" is configured, but the gateway could not confirm embeddings are ready.`,
        gatewayProbeWarning,
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Memory search",
    );
    return;
  }

  // Remote provider — check for API key. Legacy provider: "auto" resolves to OpenAI.
  if (
    hasRemoteApiKey ||
    (await hasApiKeyForProvider(provider, cfg, agentDir, {
      skipProfileResolution: opts?.skipAuthProfileResolution === true,
    }))
  ) {
    return;
  }

  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    noteFn(
      [
        `Memory search provider is set to "${provider}" but the API key was not found in the CLI environment.`,
        "The running gateway reports memory embeddings are ready for the default agent.",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
  const envVar = resolvePrimaryMemoryProviderEnvVar(provider);

  noteFn(
    [
      `Memory search provider is set to "${provider}" but no API key was found.`,
      `Semantic recall will not work without a valid API key.`,
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      `- Set ${envVar} in your environment`,
      `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
      `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

/**
 * Check whether local embeddings are available.
 *
 */
function hasLocalEmbeddings(local: { modelPath?: string }): boolean {
  const modelPath = normalizeOptionalString(local.modelPath);
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: string,
  cfg: OpenClawConfig,
  agentDir: string,
  opts?: { skipProfileResolution?: boolean },
): Promise<boolean> {
  const metadata = resolveMemoryEmbeddingProviderDoctorMetadata(provider);
  const authProviderId = metadata?.authProviderId ?? provider;
  if (
    resolveEnvApiKey(authProviderId) ||
    resolveUsableCustomProviderApiKey({ cfg, provider: authProviderId })
  ) {
    return true;
  }
  if (opts?.skipProfileResolution === true) {
    if (authProviderId === "amazon-bedrock") {
      return hasConfiguredAwsSdkAuthForProvider(authProviderId, cfg);
    }
    const orderedProfileIds = findNormalizedProviderValue(cfg.auth?.order, authProviderId);
    return orderedProfileIds === undefined
      ? hasAuthProfileStoreSourceForProvider(authProviderId, agentDir)
      : hasAuthProfileStoreSourceForProvider(authProviderId, agentDir, {
          profileIds: orderedProfileIds,
        });
  }
  if (authProviderId !== "amazon-bedrock" && !hasAnyAuthProfileStoreSource(agentDir)) {
    return false;
  }
  try {
    await resolveApiKeyForProvider({
      provider: authProviderId,
      cfg,
      agentDir,
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePrimaryMemoryProviderEnvVar(provider: string): string {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  const metadata = resolveMemoryEmbeddingProviderDoctorMetadata(provider);
  return metadata?.envVars[0] ?? `${provider.toUpperCase()}_API_KEY`;
}

function buildGatewayProbeWarning(
  probe:
    | {
        checked: boolean;
        ready: boolean;
        error?: string;
        skipped?: boolean;
      }
    | undefined,
): string | null {
  if (!probe?.checked || probe.ready) {
    return null;
  }
  const detail = probe.error?.trim();
  return detail
    ? `Gateway memory probe for default agent is not ready: ${detail}`
    : "Gateway memory probe for default agent is not ready.";
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
