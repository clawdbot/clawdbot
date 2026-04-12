import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CliBackendPlugin } from "./cli-backend.types.js";

export type SetupPluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type SetupProviderPlugin = {
  id: string;
  aliases?: string[];
  hookAliases?: string[];
  resolveConfigApiKey?: (params: {
    provider: string;
    env?: NodeJS.ProcessEnv;
    cfg?: OpenClawConfig;
    workspaceDir?: string;
  }) => string | null | undefined;
};

export type SetupPluginConfigMigration = (config: OpenClawConfig) =>
  | {
      config: OpenClawConfig;
      changes: string[];
    }
  | null
  | undefined;

export type SetupPluginAutoEnableContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
};

export type SetupPluginAutoEnableProbe = (
  ctx: SetupPluginAutoEnableContext,
) => string | string[] | null | undefined;

export type SetupOnlyPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: "setup-only";
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: Record<string, never>;
  logger: SetupPluginLogger;
  resolvePath: (input: string) => string;
  registerProvider: (provider: SetupProviderPlugin) => void;
  registerCliBackend: (backend: CliBackendPlugin) => void;
  registerConfigMigration: (migrate: SetupPluginConfigMigration) => void;
  registerAutoEnableProbe: (probe: SetupPluginAutoEnableProbe) => void;
  registerTool: (...args: unknown[]) => void;
  registerHook: (...args: unknown[]) => void;
  registerHttpRoute: (...args: unknown[]) => void;
  registerChannel: (...args: unknown[]) => void;
  registerGatewayMethod: (...args: unknown[]) => void;
  registerCli: (...args: unknown[]) => void;
  registerReload: (...args: unknown[]) => void;
  registerNodeHostCommand: (...args: unknown[]) => void;
  registerSecurityAuditCollector: (...args: unknown[]) => void;
  registerService: (...args: unknown[]) => void;
  registerTextTransforms: (...args: unknown[]) => void;
  registerSpeechProvider: (...args: unknown[]) => void;
  registerRealtimeTranscriptionProvider: (...args: unknown[]) => void;
  registerRealtimeVoiceProvider: (...args: unknown[]) => void;
  registerMediaUnderstandingProvider: (...args: unknown[]) => void;
  registerImageGenerationProvider: (...args: unknown[]) => void;
  registerVideoGenerationProvider: (...args: unknown[]) => void;
  registerMusicGenerationProvider: (...args: unknown[]) => void;
  registerWebFetchProvider: (...args: unknown[]) => void;
  registerWebSearchProvider: (...args: unknown[]) => void;
  registerInteractiveHandler: (...args: unknown[]) => void;
  onConversationBindingResolved: (...args: unknown[]) => void;
  registerCommand: (...args: unknown[]) => void;
  registerContextEngine: (...args: unknown[]) => void;
  registerCompactionProvider: (...args: unknown[]) => void;
  registerAgentHarness: (...args: unknown[]) => void;
  registerMemoryCapability: (...args: unknown[]) => void;
  registerMemoryPromptSection: (...args: unknown[]) => void;
  registerMemoryPromptSupplement: (...args: unknown[]) => void;
  registerMemoryCorpusSupplement: (...args: unknown[]) => void;
  registerMemoryFlushPlan: (...args: unknown[]) => void;
  registerMemoryRuntime: (...args: unknown[]) => void;
  registerMemoryEmbeddingProvider: (...args: unknown[]) => void;
  on: (...args: unknown[]) => void;
};

export type SetupOnlyPluginDefinition = {
  id?: string;
  register?: (api: SetupOnlyPluginApi) => void | Promise<void>;
};

export type SetupOnlyPluginModule =
  | SetupOnlyPluginDefinition
  | ((api: SetupOnlyPluginApi) => void | Promise<void>);
