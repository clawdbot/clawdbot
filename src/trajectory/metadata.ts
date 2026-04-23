import type { SkillSnapshot } from "../agents/skills.js";
import { resolveStateDir } from "../config/paths.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCommitHash } from "../infra/git-commit.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import {
  redactPathForSupport,
  sanitizeSupportSnapshotValue,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getActivePluginRegistry, listImportedRuntimePluginIds } from "../plugins/runtime.js";
import { VERSION } from "../version.js";

type BuildTrajectoryRunMetadataParams = {
  env?: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  workspaceDir: string;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  trigger?: string;
  messageProvider?: string;
  messageChannel?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  timeoutMs: number;
  fastMode?: boolean;
  thinkLevel?: string;
  reasoningLevel?: string;
  toolResultFormat?: string;
  disableTools?: boolean;
  toolsAllow?: string[];
  skillsSnapshot?: SkillSnapshot;
  systemPromptReport?: SessionSystemPromptReport;
  userPromptPrefixText?: string;
};

type BuildTrajectoryArtifactsParams = {
  status: "success" | "error" | "interrupted" | "cleanup";
  aborted: boolean;
  externalAbort: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  promptError?: string;
  promptErrorSource?: string | null;
  usage?: unknown;
  promptCache?: unknown;
  compactionCount: number;
  assistantTexts: string[];
  finalPromptText?: string;
  itemLifecycle: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
  toolMetas: Array<{ toolName: string; meta?: string }>;
  didSendViaMessagingTool: boolean;
  successfulCronAdds: number;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: unknown[];
  lastToolError?: unknown;
};

function toSortedUniqueStrings(values: readonly string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0)),
  ]
    .map((value) => value.trim())
    .toSorted((left, right) => left.localeCompare(right));
}

function buildPluginsFromActiveRegistry() {
  const registry = getActivePluginRegistry();
  if (!registry || registry.plugins.length === 0) {
    return null;
  }
  return {
    source: "active-registry",
    importedRuntimePluginIds: listImportedRuntimePluginIds(),
    entries: registry.plugins
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        origin: plugin.origin,
        enabled: plugin.enabled,
        explicitlyEnabled: plugin.explicitlyEnabled,
        activated: plugin.activated,
        imported: plugin.imported,
        activationSource: plugin.activationSource,
        activationReason: plugin.activationReason,
        status: plugin.status,
        error: plugin.error,
        format: plugin.format,
        bundleFormat: plugin.bundleFormat,
        bundleCapabilities: plugin.bundleCapabilities,
        kind: plugin.kind,
        source: plugin.source,
        rootDir: plugin.rootDir,
        workspaceDir: plugin.workspaceDir,
        toolNames: toSortedUniqueStrings(plugin.toolNames),
        hookNames: toSortedUniqueStrings(plugin.hookNames),
        channelIds: toSortedUniqueStrings(plugin.channelIds),
        cliBackendIds: toSortedUniqueStrings(plugin.cliBackendIds),
        providerIds: toSortedUniqueStrings(plugin.providerIds),
        speechProviderIds: toSortedUniqueStrings(plugin.speechProviderIds),
        realtimeTranscriptionProviderIds: toSortedUniqueStrings(
          plugin.realtimeTranscriptionProviderIds,
        ),
        realtimeVoiceProviderIds: toSortedUniqueStrings(plugin.realtimeVoiceProviderIds),
        mediaUnderstandingProviderIds: toSortedUniqueStrings(plugin.mediaUnderstandingProviderIds),
        imageGenerationProviderIds: toSortedUniqueStrings(plugin.imageGenerationProviderIds),
        videoGenerationProviderIds: toSortedUniqueStrings(plugin.videoGenerationProviderIds),
        musicGenerationProviderIds: toSortedUniqueStrings(plugin.musicGenerationProviderIds),
        webFetchProviderIds: toSortedUniqueStrings(plugin.webFetchProviderIds),
        webSearchProviderIds: toSortedUniqueStrings(plugin.webSearchProviderIds),
        memoryEmbeddingProviderIds: toSortedUniqueStrings(plugin.memoryEmbeddingProviderIds),
        agentHarnessIds: toSortedUniqueStrings(plugin.agentHarnessIds),
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildPluginsFromManifest(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const registry = loadPluginManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return {
    source: "manifest-registry",
    entries: registry.plugins
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        origin: plugin.origin,
        enabledByDefault: plugin.enabledByDefault,
        format: plugin.format,
        bundleFormat: plugin.bundleFormat,
        bundleCapabilities: toSortedUniqueStrings(plugin.bundleCapabilities),
        kind: plugin.kind,
        source: plugin.source,
        rootDir: plugin.rootDir,
        workspaceDir: plugin.workspaceDir,
        channels: toSortedUniqueStrings(plugin.channels),
        providers: toSortedUniqueStrings(plugin.providers),
        cliBackends: toSortedUniqueStrings(plugin.cliBackends),
        hooks: toSortedUniqueStrings(plugin.hooks),
        skills: toSortedUniqueStrings(plugin.skills),
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildSkillsCapture(
  skillsSnapshot: SkillSnapshot | undefined,
  redaction: SupportRedactionContext,
) {
  if (!skillsSnapshot) {
    return undefined;
  }
  const entries =
    skillsSnapshot.resolvedSkills && skillsSnapshot.resolvedSkills.length > 0
      ? skillsSnapshot.resolvedSkills.map((skill) => ({
          id: skill.name,
          name: skill.name,
          description: skill.description,
          filePath: redactPathForSupport(skill.filePath, redaction),
          baseDir: redactPathForSupport(skill.baseDir, redaction),
          source: skill.source,
          sourceInfo: sanitizeSupportSnapshotValue(skill.sourceInfo, redaction),
          disableModelInvocation: skill.disableModelInvocation,
          available: true,
        }))
      : skillsSnapshot.skills.map((skill) => ({
          id: skill.name,
          name: skill.name,
          primaryEnv: skill.primaryEnv,
          requiredEnv: skill.requiredEnv,
          available: true,
        }));
  return {
    snapshotVersion: skillsSnapshot.version,
    skillFilter: toSortedUniqueStrings(skillsSnapshot.skillFilter),
    entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

function buildTrajectorySupportRedaction(env: NodeJS.ProcessEnv): SupportRedactionContext {
  return {
    env,
    stateDir: resolveStateDir(env),
  };
}

export function buildTrajectoryRunMetadata(
  params: BuildTrajectoryRunMetadataParams,
): Record<string, unknown> {
  const env = params.env ?? process.env;
  const redaction = buildTrajectorySupportRedaction(env);
  const os = resolveOsSummary();
  const plugins =
    buildPluginsFromActiveRegistry() ??
    buildPluginsFromManifest({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env,
    });
  return {
    capturedAt: new Date().toISOString(),
    harness: {
      type: "openclaw",
      name: "OpenClaw",
      version: VERSION,
      gitSha:
        resolveCommitHash({ cwd: params.workspaceDir, env, moduleUrl: import.meta.url }) ??
        undefined,
      os,
      runtime: {
        node: process.version,
      },
      invocation: sanitizeSupportSnapshotValue([...process.argv], redaction, "programArguments"),
      entrypoint: process.argv[1] ? redactPathForSupport(process.argv[1], redaction) : undefined,
      workspaceDir: redactPathForSupport(params.workspaceDir, redaction),
      sessionFile: params.sessionFile
        ? redactPathForSupport(params.sessionFile, redaction)
        : undefined,
    },
    model: {
      provider: params.provider,
      name: params.modelId,
      api: params.modelApi,
      fastMode: params.fastMode ?? false,
      thinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
    },
    config: {
      redacted: params.config ? redactConfigObject(params.config) : undefined,
      runtime: {
        timeoutMs: params.timeoutMs,
        trigger: params.trigger,
        disableTools: params.disableTools ?? false,
        toolResultFormat: params.toolResultFormat,
        toolsAllow: toSortedUniqueStrings(params.toolsAllow),
      },
    },
    plugins,
    skills: buildSkillsCapture(params.skillsSnapshot, redaction),
    prompting: {
      skillsPrompt: params.skillsSnapshot?.prompt,
      userPromptPrefixText: params.userPromptPrefixText,
      systemPromptReport: params.systemPromptReport,
    },
    redaction: {
      config: {
        mode: "redactConfigObject",
        secretsMasked: true,
      },
      payloads: {
        mode: "sanitizeDiagnosticPayload",
        credentialsRemoved: true,
        imageDataRedacted: true,
      },
      harness: {
        mode: "diagnostic-support-redaction",
        programArgumentsRedacted: true,
        localPathsRedacted: true,
      },
    },
    metadata: {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
    },
  };
}

export function buildTrajectoryArtifacts(
  params: BuildTrajectoryArtifactsParams,
): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    finalStatus: params.status,
    aborted: params.aborted,
    externalAbort: params.externalAbort,
    timedOut: params.timedOut,
    idleTimedOut: params.idleTimedOut,
    timedOutDuringCompaction: params.timedOutDuringCompaction,
    promptError: params.promptError,
    promptErrorSource: params.promptErrorSource,
    usage: params.usage,
    promptCache: params.promptCache,
    compactionCount: params.compactionCount,
    assistantTexts: params.assistantTexts,
    finalPromptText: params.finalPromptText,
    itemLifecycle: params.itemLifecycle,
    toolMetas: params.toolMetas,
    didSendViaMessagingTool: params.didSendViaMessagingTool,
    successfulCronAdds: params.successfulCronAdds,
    messagingToolSentTexts: params.messagingToolSentTexts,
    messagingToolSentMediaUrls: params.messagingToolSentMediaUrls,
    messagingToolSentTargets: params.messagingToolSentTargets,
    lastToolError: params.lastToolError,
  };
}
