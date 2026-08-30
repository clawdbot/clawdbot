import { resolveSandboxWorkspaceAuthority } from "../../agents/sandbox/workspace-authority.js";
// Plugin runtime entrypoint assembles runtime helpers available to activated plugins.
import { getRuntimeConfig } from "../../config/config.js";
import {
  generateImage as generateRuntimeImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  generateMusic as generateRuntimeMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import { RequestScopedSubagentRuntimeError } from "../../plugin-sdk/error-runtime.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  generateVideo as generateRuntimeVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeState } from "./runtime-state.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { PluginRuntimeFactory, PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../plugin-sdk/tts-runtime.js"));
const loadTtsRequestRuntime = createLazyRuntimeModule(() => import("./runtime-tts-request.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);
const loadGatewayPluginRuntime = createLazyRuntimeModule(
  () => import("../../gateway/server-plugins.js"),
);

function createRuntimeGateway(): PluginRuntime["gateway"] {
  return {
    isAvailable: async () => {
      const runtime = await loadGatewayPluginRuntime();
      return runtime.hasInProcessGatewayContext();
    },
    request: async (method, params, options) => {
      const runtime = await loadGatewayPluginRuntime();
      return runtime.dispatchTrustedPluginGatewayMethod(method, params, options);
    },
  };
}

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  const bindTtsRequestRuntime = createLazyRuntimeMethodBinder(loadTtsRequestRuntime);
  return {
    prepareTtsRequest: bindTtsRequestRuntime((runtime) => runtime.prepareTtsRequest),
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechStream: bindTtsRuntime((runtime) => runtime.textToSpeechStream),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    extractStructuredWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.extractStructuredWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: (params) => generateRuntimeImage(params),
    listProviders: (params) => listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeVideoGeneration(): PluginRuntime["videoGeneration"] {
  return {
    generate: (params) => generateRuntimeVideo(params),
    listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  };
}

function createRuntimeMusicGeneration(): PluginRuntime["musicGeneration"] {
  return {
    generate: (params) => generateRuntimeMusic(params),
    listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  };
}

function createRuntimeLlmFacade(): PluginRuntime["llm"] {
  const loadAcquireLocalService = createLazyRuntimeMethod(
    () => import("../../agents/provider-local-service.js"),
    (runtime) => runtime.createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig),
  );
  const loadLlm = createLazyRuntimeSurface(
    () => import("./runtime-llm.runtime.js"),
    (m) =>
      m.createRuntimeLlm({
        getConfig: getRuntimeConfig,
        authority: {
          allowComplete: true,
        },
      }),
  );
  return {
    acquireLocalService: (...args) => loadAcquireLocalService(...args),
    complete: async (params) => {
      const llm = await loadLlm();
      return llm.complete(params);
    },
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModelCore,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveProviderRuntimeApiKey,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
  };
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new RequestScopedSubagentRuntimeError();
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    deleteSession: unavailable,
  };
}

function createUnavailableNodesRuntime(): PluginRuntime["nodes"] {
  const unavailable = () => {
    throw new Error("Plugin node runtime is only available inside the Gateway.");
  };
  return {
    list: unavailable,
    invoke: unavailable,
    openDuplex: unavailable,
  };
}

function createRuntimeWorktrees(): PluginRuntime["worktrees"] {
  const loadService = () => import("../../agents/worktrees/service.js");
  return {
    async resolveCheckoutRoot(params) {
      const { findGitCheckoutRoot } = await import("../../agents/worktrees/git.js");
      return findGitCheckoutRoot(params.path) ?? undefined;
    },
    async hasSelfContainedCheckoutMetadata(params) {
      const { hasSelfContainedGitMetadata } = await import("../../agents/worktrees/git.js");
      return await hasSelfContainedGitMetadata(params.path);
    },
    async create(params) {
      const { managedWorktrees } = await loadService();
      const record = await managedWorktrees.create(params);
      await managedWorktrees.acquire(record.id);
      return { id: record.id, path: record.path, branch: record.branch };
    },
    async release(params) {
      const { managedWorktrees } = await loadService();
      await managedWorktrees.releaseByPath(params.path);
    },
    async removeIfLossless(params) {
      const { managedWorktrees } = await loadService();
      return managedWorktrees.removeIfLosslessByPath(params.path, {
        ownerKind: params.ownerKind,
        ownerId: params.ownerId,
      });
    },
  };
}

function createRuntimeSandbox(agent: PluginRuntime["agent"]): PluginRuntime["sandbox"] {
  const resolveWorkspaceAuthority = (
    params: Parameters<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>[0],
  ) =>
    resolveSandboxWorkspaceAuthority({
      ...params,
      sessionEntry: agent.session.getSessionEntry({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }),
    });
  return {
    resolveWorkspaceAuthority,
    async prepareWorkspaceAuthority(params) {
      const authority = resolveWorkspaceAuthority(params);
      if (!authority.sandboxed || authority.confinementError) {
        return authority;
      }
      const { resolveSandboxContext } = await import("../../agents/sandbox/context.js");
      await resolveSandboxContext({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        requireCurrentConfig: true,
      });
      return authority;
    },
  };
}

// Loaded by path from the plugin loader, so static export analysis cannot see this contract.
export const createPluginRuntime: PluginRuntimeFactory = (
  _options = {},
  state = createRuntimeState(),
) => {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    managedTaskFlow: taskFlow,
  });
  const agent = createRuntimeAgent();
  const runtime = {
    // Sourced from the shared OpenClaw version resolver (#52899) so plugins
    // always see the same version the CLI reports, avoiding API-version drift.
    version: VERSION,
    gateway: _options.gateway ?? createRuntimeGateway(),
    config: createRuntimeConfig(),
    agent,
    hooks: _options.hooks ?? {
      dispatchHookAgentTurn: async () => {
        throw new Error("Plugin hook runtime is only available inside the Gateway.");
      },
    },
    subagent: _options.subagent ?? createUnavailableSubagentRuntime(),
    nodes: _options.nodes ?? createUnavailableNodesRuntime(),
    sandbox: createRuntimeSandbox(agent),
    worktrees: createRuntimeWorktrees(),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(
      _options.dispatchReplyFromConfig
        ? { dispatchReplyFromConfig: _options.dispatchReplyFromConfig }
        : undefined,
    ),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state,
    tasks,
  } satisfies Omit<
    PluginRuntime,
    | "tts"
    | "mediaUnderstanding"
    | "modelAuth"
    | "imageGeneration"
    | "videoGeneration"
    | "musicGeneration"
    | "llm"
  > &
    Partial<
      Pick<
        PluginRuntime,
        | "tts"
        | "mediaUnderstanding"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
        | "llm"
      >
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);
  defineCachedValue(runtime, "llm", createRuntimeLlmFacade);

  return runtime as unknown as PluginRuntime;
};

export type { PluginRuntime } from "./types.js";
