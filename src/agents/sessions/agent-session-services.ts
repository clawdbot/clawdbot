/**
 * Agent session service factory.
 *
 * Creates cwd-bound auth, settings, model registry, resource loader, and session instances for the CLI runtime.
 */
import { join } from "node:path";
import type { Model } from "../../llm/types.js";
import { getAgentDir } from "../config.js";
import type { ThinkingLevel } from "../runtime/index.js";
import { AuthStorage } from "./auth-storage.js";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import { ModelRegistry } from "./model-registry.js";
import {
  DefaultResourceLoader,
  type DefaultResourceLoaderOptions,
  type ResourceLoader,
} from "./resource-loader.js";
import {
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
} from "./sdk.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
  cwd: string;
  agentDir?: string;
  authStorage?: AuthStorage;
  settingsManager?: SettingsManager;
  modelRegistry?: ModelRegistry;
  extensionFlagValues?: Map<string, boolean | string>;
  resourceLoaderOptions?: Omit<
    DefaultResourceLoaderOptions,
    "cwd" | "agentDir" | "settingsManager"
  >;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
  tools?: string[];
  noTools?: CreateAgentSessionOptions["noTools"];
  customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
  cwd: string;
  agentDir: string;
  authStorage: AuthStorage;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
  resourceLoader: ResourceLoader,
  extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
  if (!extensionFlagValues) {
    return [];
  }

  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const extensionsResult = resourceLoader.getExtensions();
  const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
  for (const extension of extensionsResult.extensions) {
    for (const [name, flag] of extension.flags) {
      registeredFlags.set(name, { type: flag.type });
    }
  }

  const unknownFlags: string[] = [];
  for (const [name, value] of extensionFlagValues) {
    const flag = registeredFlags.get(name);
    if (!flag) {
      unknownFlags.push(name);
      continue;
    }
    if (flag.type === "boolean") {
      extensionsResult.runtime.flagValues.set(name, true);
      continue;
    }
    if (typeof value === "string") {
      extensionsResult.runtime.flagValues.set(name, value);
      continue;
    }
    diagnostics.push({
      type: "error",
      message: `Extension flag "--${name}" requires a value`,
    });
  }

  if (unknownFlags.length > 0) {
    diagnostics.push({
      type: "error",
      message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
    });
  }

  return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? getAgentDir();
  const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const modelRegistry =
    options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const resourceLoader = new DefaultResourceLoader({
    ...options.resourceLoaderOptions,
    cwd,
    agentDir,
    settingsManager,
  });
  await resourceLoader.reload();

  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const extensionsResult = resourceLoader.getExtensions();
  for (const { name, config, extensionPath } of extensionsResult.runtime
    .pendingProviderRegistrations) {
    try {
      modelRegistry.registerProvider(name, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        type: "error",
        message: `Extension "${extensionPath}" error: ${message}`,
      });
    }
  }
  extensionsResult.runtime.pendingProviderRegistrations = [];
  diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

  return {
    cwd,
    agentDir,
    authStorage,
    settingsManager,
    modelRegistry,
    resourceLoader,
    diagnostics,
  };
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
  options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
  return createAgentSession({
    cwd: options.services.cwd,
    agentDir: options.services.agentDir,
    authStorage: options.services.authStorage,
    settingsManager: options.services.settingsManager,
    modelRegistry: options.services.modelRegistry,
    resourceLoader: options.services.resourceLoader,
    sessionManager: options.sessionManager,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    scopedModels: options.scopedModels,
    tools: options.tools,
    noTools: options.noTools,
    customTools: options.customTools,
    sessionStartEvent: options.sessionStartEvent,
  });
}
