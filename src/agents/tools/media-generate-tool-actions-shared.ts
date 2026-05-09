import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listMediaGenerationProviderModels,
  synthesizeMediaGenerationCatalogEntries,
  type MediaGenerationCatalogKind,
} from "../../media-generation/catalog.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isCapabilityProviderConfigured } from "./media-tool-shared.js";

type MediaGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type TaskStatusTextBuilder<Task> = (task: Task, params?: { duplicateGuard?: boolean }) => string;
type MediaGenerateProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  capabilities: unknown;
  isConfigured?: (ctx: { cfg?: OpenClawConfig; agentDir?: string }) => boolean;
};

type MediaGenerateListProviderDetails<TProvider extends MediaGenerateProvider> = {
  id: string;
  label?: string;
  defaultModel?: string;
  models: string[];
  modes: string[];
  configured: boolean;
  authEnvVars: string[];
  capabilities: TProvider["capabilities"];
  catalog: ReturnType<typeof synthesizeMediaGenerationCatalogEntries<TProvider["capabilities"]>>;
};

export type { MediaGenerateActionResult };

export function createMediaGenerateProviderListActionResult<
  TProvider extends MediaGenerateProvider,
>(params: {
  kind: MediaGenerationCatalogKind;
  providers: TProvider[];
  emptyText: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  listModes: (provider: TProvider) => string[];
  summarizeCapabilities: (provider: TProvider) => string;
  formatAuthHint?: (provider: { id: string; authEnvVars: readonly string[] }) => string | undefined;
}): MediaGenerateActionResult {
  if (params.providers.length === 0) {
    return {
      content: [{ type: "text", text: params.emptyText }],
      details: { providers: [] },
    };
  }

  const providerDetails: Array<MediaGenerateListProviderDetails<TProvider>> = params.providers.map(
    (provider) => {
      const modes = params.listModes(provider);
      const models = listMediaGenerationProviderModels(provider);
      return {
        id: provider.id,
        ...(provider.label ? { label: provider.label } : {}),
        ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
        models,
        modes,
        configured: isCapabilityProviderConfigured({
          providers: params.providers,
          provider,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
        }),
        authEnvVars: getProviderEnvVars(provider.id),
        capabilities: provider.capabilities,
        catalog: synthesizeMediaGenerationCatalogEntries({
          kind: params.kind,
          provider,
          modes,
        }),
      };
    },
  );

  const lines = providerDetails.flatMap((details, index) => {
    const provider = params.providers[index];
    const authHints = getProviderEnvVars(provider.id);
    const capabilities = params.summarizeCapabilities(provider);
    const modelLine = details.models.length > 0 ? details.models.join(", ") : "unknown";
    const authHint =
      params.formatAuthHint?.({ id: details.id, authEnvVars: authHints }) ??
      (authHints.length > 0 ? `set ${authHints.join(" / ")} to use ${details.id}/*` : undefined);
    return [
      `${details.id}${details.defaultModel ? ` (default ${details.defaultModel})` : ""}`,
      `  models: ${modelLine}`,
      `  configured: ${details.configured ? "yes" : "no"}`,
      ...(authHint ? [`  auth: ${authHint}`] : []),
      "  source: static",
      ...(capabilities ? [`  capabilities: ${capabilities}`] : []),
    ];
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      kind: params.kind,
      providers: providerDetails,
    },
  };
}

export function createMediaGenerateTaskStatusActions<Task>(params: {
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}) {
  return {
    createStatusActionResult(sessionKey?: string): MediaGenerateActionResult {
      return createMediaGenerateStatusActionResult({
        sessionKey,
        inactiveText: params.inactiveText,
        findActiveTask: params.findActiveTask,
        buildStatusText: params.buildStatusText,
        buildStatusDetails: params.buildStatusDetails,
      });
    },

    createDuplicateGuardResult(sessionKey?: string): MediaGenerateActionResult | undefined {
      return createMediaGenerateDuplicateGuardResult({
        sessionKey,
        findActiveTask: params.findActiveTask,
        buildStatusText: params.buildStatusText,
        buildStatusDetails: params.buildStatusDetails,
      });
    },
  };
}

function createMediaGenerateStatusActionResult<Task>(params: {
  sessionKey?: string;
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return {
      content: [{ type: "text", text: params.inactiveText }],
      details: {
        action: "status",
        active: false,
      },
    };
  }
  return {
    content: [{ type: "text", text: params.buildStatusText(activeTask) }],
    details: {
      action: "status",
      ...params.buildStatusDetails(activeTask),
    },
  };
}

function createMediaGenerateDuplicateGuardResult<Task>(params: {
  sessionKey?: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult | undefined {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return undefined;
  }
  return {
    content: [
      {
        type: "text",
        text: params.buildStatusText(activeTask, { duplicateGuard: true }),
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...params.buildStatusDetails(activeTask),
    },
  };
}
