import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";

type MediaGenerateActionResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

type TaskStatusTextBuilder<Task> = (task: Task, params?: { duplicateGuard?: boolean }) => string;
type MediaGenerateProvider = {
  id: string;
  defaultModel?: string;
  models?: string[];
  capabilities: unknown;
};

export type { MediaGenerateActionResult };

export function createMediaGenerateProviderListActionResult<
  TProvider extends MediaGenerateProvider,
>(params: {
  providers: TProvider[];
  emptyText: string;
  listModes: (provider: TProvider) => string[];
  summarizeCapabilities: (provider: TProvider) => string;
}): MediaGenerateActionResult {
  if (params.providers.length === 0) {
    return {
      content: [{ type: "text", text: params.emptyText }],
      details: { providers: [] },
    };
  }

  const lines = params.providers.map((provider) => {
    const authHints = getProviderEnvVars(provider.id);
    const capabilities = params.summarizeCapabilities(provider);
    return [
      `${provider.id}: default=${provider.defaultModel ?? "none"}`,
      provider.models?.length ? `models=${provider.models.join(", ")}` : null,
      capabilities ? `capabilities=${capabilities}` : null,
      authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" | ");
  });

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      providers: params.providers.map((provider) => ({
        id: provider.id,
        defaultModel: provider.defaultModel,
        models: provider.models ?? [],
        modes: params.listModes(provider),
        authEnvVars: getProviderEnvVars(provider.id),
        capabilities: provider.capabilities,
      })),
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
