import fsSync from "node:fs";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { hasAnyAuthProfileStoreSource } from "../agents/auth-profiles.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import {
  resolveApiKeyForProvider,
  resolveEnvApiKey,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { checkQmdBinaryAvailability } from "../memory-host-sdk/engine-qmd.js";
import { DEFAULT_LOCAL_MODEL } from "../memory-host-sdk/host/embedding-defaults.js";
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
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
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

function isKeyOptionalMemoryProvider(providerId: string): boolean {
  return providerId === "local" || providerId === "ollama" || providerId === "lmstudio";
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
          const lines = [
            "Memory recall artifacts repaired:",
            repair.rewroteStore
              ? `- rewrote recall store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid entries)` : ""}`
              : null,
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
  if (!Object.prototype.hasOwnProperty.call(plugins.entries, memorySlot)) {
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
    };
  },
): Promise<void> {
  await noteWorkspaceMemoryHealth(cfg);

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved?.remote?.apiKey);

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

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
    note("No active memory plugin is registered for the current config.", "Memory search");
    return;
  }
  if (backendConfig.backend === "qmd") {
    const qmdCheck = await checkQmdBinaryAvailability({
      command: backendConfig.qmd?.command ?? "qmd",
      env: process.env,
      cwd: resolveAgentWorkspaceDir(cfg, agentId),
    });
    if (!qmdCheck.available) {
      note(
        [
          `QMD memory backend is configured, but the qmd binary could not be started (${backendConfig.qmd?.command ?? "qmd"}).`,
          qmdCheck.error ? `Probe error: ${qmdCheck.error}` : null,
          "",
          "Fix (pick one):",
          "- Install the supported QMD package: npm install -g @tobilu/qmd (or bun install -g @tobilu/qmd)",
          `- Set an explicit binary path: ${formatCliCommand("openclaw config set memory.qmd.command /absolute/path/to/qmd")}`,
          `- Or switch back to builtin memory: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Memory search",
      );
    }
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      const suggestedRemoteProvider = resolveSuggestedRemoteMemoryProvider();
      if (hasLocalEmbeddings(resolved.local, true)) {
        // Model path looks valid (explicit file, hf: URL, or default model).
        // If a gateway probe is available and reports not-ready, warn anyway —
        // the model download or node-llama-cpp setup may have failed at runtime.
        if (opts?.gatewayMemoryProbe?.checked && !opts.gatewayMemoryProbe.ready) {
          const detail = opts.gatewayMemoryProbe.error?.trim();
          note(
            [
              'Memory search provider is set to "local" and a model path is configured,',
              "but the gateway reports local embeddings are not ready.",
              detail ? `Gateway probe: ${detail}` : null,
              "",
              `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
            ]
              .filter(Boolean)
              .join("\n"),
            "Memory search",
          );
        }
        return;
      }
      note(
        [
          'Memory search provider is set to "local" but no local model file was found.',
          "",
          "Fix (pick one):",
          `- Install node-llama-cpp and set a local model path in config`,
          suggestedRemoteProvider
            ? `- Switch to a remote provider: ${formatCliCommand(`openclaw config set agents.defaults.memorySearch.provider ${suggestedRemoteProvider}`)}`
            : `- Switch to a remote embedding provider in config`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    if (isKeyOptionalMemoryProvider(resolved.provider)) {
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
      note(
        [
          gatewayProbeWarning
            ? `Memory search provider "${resolved.provider}" is configured, but the gateway reports embeddings are not ready.`
            : `Memory search provider "${resolved.provider}" is configured, but the gateway could not confirm embeddings are ready.`,
          gatewayProbeWarning,
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ]
          .filter(Boolean)
          .join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      note(
        [
          `Memory search provider is set to "${resolved.provider}" but the API key was not found in the CLI environment.`,
          "The running gateway reports memory embeddings are ready for the default agent.",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
    const envVar = resolvePrimaryMemoryProviderEnvVar(resolved.provider);
    note(
      [
        `Memory search provider is set to "${resolved.provider}" but no API key was found.`,
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
    return;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    return;
  }
  const autoSelectProviders = listAutoSelectMemoryEmbeddingProviderDoctorMetadata().filter(
    (provider) => provider.transport === "remote",
  );
  for (const provider of autoSelectProviders) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider.authProviderId, cfg, agentDir))) {
      return;
    }
  }

  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    note(
      [
        'Memory search provider is set to "auto" but the API key was not found in the CLI environment.',
        "The running gateway reports memory embeddings are ready for the default agent.",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);

  note(
    [
      "Memory search is enabled, but no embedding provider is ready.",
      "Semantic recall needs at least one embedding provider.",
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      `- Set ${formatMemoryProviderEnvVarList(autoSelectProviders)} in your environment`,
      `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
      `- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
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
 * When `useDefaultFallback` is true (explicit `provider: "local"`), an empty
 * modelPath is treated as available because the runtime falls back to
 * DEFAULT_LOCAL_MODEL (an auto-downloaded HuggingFace model).
 *
 * When false (provider: "auto"), we only consider local available if the user
 * explicitly configured a local file path — matching `canAutoSelectLocal()`
 * in the runtime, which skips local for empty/hf: model paths.
 */
function hasLocalEmbeddings(local: { modelPath?: string }, useDefaultFallback = false): boolean {
  const modelPath =
    normalizeOptionalString(local.modelPath) ||
    (useDefaultFallback ? DEFAULT_LOCAL_MODEL : undefined);
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
): Promise<boolean> {
  const metadata = resolveMemoryEmbeddingProviderDoctorMetadata(provider);
  const authProviderId = metadata?.authProviderId ?? provider;
  if (
    resolveEnvApiKey(authProviderId) ||
    resolveUsableCustomProviderApiKey({ cfg, provider: authProviderId })
  ) {
    return true;
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
  const metadata = resolveMemoryEmbeddingProviderDoctorMetadata(provider);
  return metadata?.envVars[0] ?? `${provider.toUpperCase()}_API_KEY`;
}

function formatMemoryProviderEnvVarList(providers: Array<{ envVars: string[] }>): string {
  return [...new Set(providers.flatMap((provider) => provider.envVars).filter(Boolean))].join(", ");
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
