import { resolveSandboxWorkspaceAuthority } from "../../agents/sandbox/workspace-authority.js";
// Plugin runtime entrypoint assembles runtime helpers available to activated plugins.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
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
import { gatewaySubagentState } from "./gateway-bindings.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../plugin-sdk/tts-runtime.js"));
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
  return {
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
    (runtime) => runtime.getRuntimeAuthForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
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
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

// ── Process-global gateway subagent runtime ─────────────────────────
// The gateway creates a real subagent runtime during startup, but gateway-owned
// plugin registries may be loaded (and cached) before the gateway path runs.
// A process-global holder lets explicitly gateway-bindable runtimes resolve the
// active gateway subagent dynamically without changing the default behavior for
// ordinary plugin runtimes.

/**
 * Create a late-binding subagent that resolves to:
 * 1. An explicitly provided subagent (from runtimeOptions), OR
 * 2. The process-global gateway subagent when the caller explicitly opts in, OR
 * 3. The unavailable fallback (throws with a clear error message).
 */
function createLateBindingSubagent(
  explicit?: PluginRuntime["subagent"],
  allowGatewaySubagentBinding = false,
): PluginRuntime["subagent"] {
  if (explicit) {
    return explicit;
  }

  const unavailable = createUnavailableSubagentRuntime();
  if (!allowGatewaySubagentBinding) {
    return unavailable;
  }

  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.subagent ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
}

function createUnavailableNodesRuntime(): PluginRuntime["nodes"] {
  const unavailable = () => {
    throw new Error("Plugin node runtime is only available inside the Gateway.");
  };
  return {
    list: unavailable,
    invoke: unavailable,
  };
}

function createLateBindingNodes(allowGatewayBinding = false): PluginRuntime["nodes"] {
  const unavailable = createUnavailableNodesRuntime();
  if (!allowGatewayBinding) {
    return unavailable;
  }
  return new Proxy(unavailable, {
    get(_target, prop, _receiver) {
      const resolved = gatewaySubagentState.nodes ?? unavailable;
      return Reflect.get(resolved, prop, resolved);
    },
  });
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
export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const agent = createRuntimeAgent();
  const runtime = {
    // Sourced from the shared OpenClaw version resolver (#52899) so plugins
    // always see the same version the CLI reports, avoiding API-version drift.
    version: VERSION,
    gateway: createRuntimeGateway(),
    config: createRuntimeConfig(),
    agent,
    subagent: createLateBindingSubagent(
      _options.subagent,
      _options.allowGatewaySubagentBinding === true,
    ),
    nodes: _options.nodes ?? createLateBindingNodes(_options.allowGatewaySubagentBinding === true),
    sandbox: createRuntimeSandbox(agent),
    worktrees: createRuntimeWorktrees(),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: {
      resolveStateDir,
      openKeyedStore: () => {
        throw new Error("openKeyedStore is only available through the plugin runtime proxy.");
      },
      openSyncKeyedStore: () => {
        throw new Error("openSyncKeyedStore is only available through the plugin runtime proxy.");
      },
      openChannelIngressQueue: () => {
        throw new Error(
          "openChannelIngressQueue is only available through the plugin runtime proxy.",
        );
      },
    },
    tasks,
    taskFlow,
  } satisfies Omit<
    PluginRuntime,
    | "tts"
    | "mediaUnderstanding"
    | "stt"
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
        | "stt"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
        | "llm"
      >
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);
  defineCachedValue(runtime, "llm", createRuntimeLlmFacade);

  return runtime as unknown as PluginRuntime;
}

export type { PluginRuntime } from "./types.js";
