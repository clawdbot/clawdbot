/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxFormat from "typebox/format";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledLlm from "../../../plugin-sdk/llm.js";
import { installOpenClawInternalCorePackageNativeResolver } from "../../../plugins/plugin-sdk-native-resolver.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
} from "../../../plugins/sdk-alias.js";
import { isBunBinary } from "../../config.js";
import {
  Agent,
  bashExecutionToText,
  buildSessionContext,
  calculateContextTokens,
  collectEntriesForBranchSummaryFromBranches,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummary,
  getLastAssistantUsage,
  openClawAgentCoreRuntime,
  prepareBranchEntries,
  prepareCompaction,
  runAgentLoop,
  serializeConversation,
  shouldCompact,
  uuidv7,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_COMPACTION_SETTINGS,
} from "../../runtime/index.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import * as bundledAgentSessions from "../extension-sdk.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import type {
  Extension,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionRuntime,
  ExtensionShortcut,
  LoadExtensionsResult,
  MessageRenderer,
  ProviderConfig,
  RegisteredCommand,
  ToolDefinition,
} from "./types.js";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const bundledAgentCore = {
  Agent,
  bashExecutionToText,
  buildSessionContext,
  calculateContextTokens,
  collectEntriesForBranchSummaryFromBranches,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummary,
  getLastAssistantUsage,
  openClawAgentCoreRuntime,
  prepareBranchEntries,
  prepareCompaction,
  runAgentLoop,
  serializeConversation,
  shouldCompact,
  uuidv7,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_COMPACTION_SETTINGS,
};

const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/format": bundledTypeboxFormat,
  "typebox/value": bundledTypeboxValue,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
  "@sinclair/typebox/format": bundledTypeboxFormat,
  "@sinclair/typebox/value": bundledTypeboxValue,
  "openclaw/plugin-sdk/agent-core": bundledAgentCore,
  "@openclaw/plugin-sdk/agent-core": bundledAgentCore,
  "openclaw/plugin-sdk/llm": bundledLlm,
  "@openclaw/plugin-sdk/llm": bundledLlm,
  "openclaw/plugin-sdk/agent-sessions": bundledAgentSessions,
  "@openclaw/plugin-sdk/agent-sessions": bundledAgentSessions,
};

const require = createRequire(import.meta.url);

let aliases: Record<string, string> | null = null;
let createJitiLoaderFactory: typeof createJiti | undefined;
let nativeExtensionLoadCounter = 0;
// One cwd slot bounds the process cache. The generation keeps an in-flight
// load from repopulating it after an explicit reload or cwd change.
let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionFactoryCache = new Map<string, ExtensionFactory>();
const EXTENSION_LOADER_ALIAS_IMPORT_PATTERN =
  /(?:@openclaw\/plugin-sdk|openclaw\/plugin-sdk|@sinclair\/typebox|typebox)(?:\/[A-Za-z0-9_-]+)?/u;
const RELATIVE_EXTENSION_IMPORT_PATTERN =
  /(?:import\s*(?:[^'"]*?\s*from\s*)?["']\.{1,2}\/|export\s*(?:[^'"]*?\s*from\s*)["']\.{1,2}\/|import\s*\(\s*["']\.{1,2}\/|require\s*\(\s*["']\.{1,2}\/)/u;
const COMMONJS_EXTENSION_EXPORT_PATTERN = /\b(?:module\.exports|exports\.)/u;

async function loadCreateJitiLoaderFactory(): Promise<typeof createJiti> {
  if (createJitiLoaderFactory) {
    return createJitiLoaderFactory;
  }
  const loaded = (await import("jiti/static")) as { createJiti?: typeof createJiti };
  if (typeof loaded.createJiti !== "function") {
    throw new Error("jiti/static module did not export createJiti");
  }
  createJitiLoaderFactory = loaded.createJiti;
  return createJitiLoaderFactory;
}

function resolveExtensionSafeAgentSessionsEntry(): string {
  const currentDirname = path.dirname(fileURLToPath(import.meta.url));
  const jsEntry = path.resolve(currentDirname, "..", "extension-sdk.js");
  return fs.existsSync(jsEntry) ? jsEntry : path.resolve(currentDirname, "..", "extension-sdk.ts");
}

function getExtensionLoaderAliases(): Record<string, string> {
  if (aliases) {
    return aliases;
  }

  const agentSessionsEntry = resolveExtensionSafeAgentSessionsEntry();
  const typeboxEntry = require.resolve("typebox");
  const typeboxCompileEntry = require.resolve("typebox/compile");
  const typeboxFormatEntry = require.resolve("typebox/format");
  const typeboxValueEntry = require.resolve("typebox/value");
  const loaderModulePath = fileURLToPath(import.meta.url);

  aliases = {
    ...buildPluginLoaderAliasMap(loaderModulePath, process.argv[1], import.meta.url),
    // The public agent-sessions export includes the resource loader. Extensions
    // load through the resource loader, so use the cycle-safe SDK barrel here.
    "openclaw/plugin-sdk/agent-sessions": agentSessionsEntry,
    "@openclaw/plugin-sdk/agent-sessions": agentSessionsEntry,
    typebox: typeboxEntry,
    "typebox/compile": typeboxCompileEntry,
    "typebox/format": typeboxFormatEntry,
    "typebox/value": typeboxValueEntry,
    "@sinclair/typebox": typeboxEntry,
    "@sinclair/typebox/compile": typeboxCompileEntry,
    "@sinclair/typebox/format": typeboxFormatEntry,
    "@sinclair/typebox/value": typeboxValueEntry,
  };

  return aliases;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
  const normalized = normalizeUnicodeSpaces(p);
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("~")) {
    return path.join(os.homedir(), normalized.slice(1));
  }
  return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
  const expanded = expandPath(extPath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

type ExtensionCacheScope = {
  cwd: string;
  generation: number;
};

type ExtensionLoadContext = {
  cacheScope?: ExtensionCacheScope;
  sourceTransformLoader?: ReturnType<typeof createJiti>;
};

export function clearExtensionCache(): void {
  extensionFactoryCache.clear();
  extensionCacheCwd = undefined;
  extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheScope {
  const resolvedCwd = path.resolve(expandPath(cwd));
  if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
    clearExtensionCache();
  }
  extensionCacheCwd = resolvedCwd;
  return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

function isCurrentCacheScope(scope: ExtensionCacheScope | undefined): scope is ExtensionCacheScope {
  return (
    scope !== undefined &&
    extensionCacheCwd === scope.cwd &&
    extensionCacheGeneration === scope.generation
  );
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = () => {
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading.",
    );
  };
  const state: { staleMessage?: string } = {};
  const assertActive = () => {
    if (state.staleMessage) {
      throw new Error(state.staleMessage);
    }
  };

  const runtime: ExtensionRuntime = {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    // registerTool() is valid during extension load; refresh is only needed post-bind.
    refreshTools: () => {},
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    assertActive,
    invalidate: (message) => {
      state.staleMessage ??=
        message ??
        "This extension ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
    },
    // Pre-bind: queue registrations so bindCore() can flush them once the
    // model registry is available. bindCore() replaces both with direct calls.
    registerProvider: (name, config, extensionPath = "<unknown>") => {
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
        (r) => r.name !== name,
      );
    },
  };

  return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
  extension: Extension,
  runtime: ExtensionRuntime,
  cwd: string,
  eventBus: EventBus,
): ExtensionAPI {
  const api = {
    // Registration methods - write to extension
    on(event: string, handler: HandlerFn): void {
      runtime.assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },

    registerTool(tool: ToolDefinition): void {
      runtime.assertActive();
      extension.tools.set(tool.name, {
        definition: tool,
        sourceInfo: extension.sourceInfo,
      });
      runtime.refreshTools();
    },

    registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
      runtime.assertActive();
      extension.commands.set(name, {
        name,
        sourceInfo: extension.sourceInfo,
        ...options,
      });
    },

    registerShortcut(
      shortcut: ExtensionShortcut["shortcut"],
      options: {
        description?: string;
        handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
      },
    ): void {
      runtime.assertActive();
      extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
    },

    registerFlag(
      name: string,
      options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
    ): void {
      runtime.assertActive();
      extension.flags.set(name, { name, extensionPath: extension.path, ...options });
      if (options.default !== undefined && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },

    registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
      runtime.assertActive();
      extension.messageRenderers.set(customType, renderer as MessageRenderer);
    },

    // Flag access - checks extension registered it, reads from runtime
    getFlag(name: string): boolean | string | undefined {
      runtime.assertActive();
      if (!extension.flags.has(name)) {
        return undefined;
      }
      return runtime.flagValues.get(name);
    },

    // Action methods - delegate to shared runtime
    sendMessage(message, options): void {
      runtime.assertActive();
      runtime.sendMessage(message, options);
    },

    sendUserMessage(content, options): void {
      runtime.assertActive();
      runtime.sendUserMessage(content, options);
    },

    appendEntry(customType: string, data?: unknown): void {
      runtime.assertActive();
      runtime.appendEntry(customType, data);
    },

    setSessionName(name: string): void {
      runtime.assertActive();
      runtime.setSessionName(name);
    },

    getSessionName(): string | undefined {
      runtime.assertActive();
      return runtime.getSessionName();
    },

    setLabel(entryId: string, label: string | undefined): void {
      runtime.assertActive();
      runtime.setLabel(entryId, label);
    },

    exec(command: string, args: string[], options?: ExecOptions) {
      runtime.assertActive();
      return execCommand(command, args, options?.cwd ?? cwd, options);
    },

    getActiveTools(): string[] {
      runtime.assertActive();
      return runtime.getActiveTools();
    },

    getAllTools() {
      runtime.assertActive();
      return runtime.getAllTools();
    },

    setActiveTools(toolNames: string[]): void {
      runtime.assertActive();
      runtime.setActiveTools(toolNames);
    },

    getCommands() {
      runtime.assertActive();
      return runtime.getCommands();
    },

    setModel(model) {
      runtime.assertActive();
      return runtime.setModel(model);
    },

    getThinkingLevel() {
      runtime.assertActive();
      return runtime.getThinkingLevel();
    },

    setThinkingLevel(level) {
      runtime.assertActive();
      runtime.setThinkingLevel(level);
    },

    registerProvider(name: string, config: ProviderConfig) {
      runtime.assertActive();
      runtime.registerProvider(name, config, extension.path);
    },

    unregisterProvider(name: string) {
      runtime.assertActive();
      runtime.unregisterProvider(name, extension.path);
    },

    events: eventBus,
  } as ExtensionAPI;

  return api;
}

function resolveExtensionFactory(module: unknown): ExtensionFactory | undefined {
  const candidate =
    typeof module === "object" && module !== null && "default" in module
      ? (module as { default?: unknown }).default
      : module;
  if (typeof candidate === "function") {
    return candidate as ExtensionFactory;
  }
  const nestedCandidate =
    typeof candidate === "object" && candidate !== null && "default" in candidate
      ? (candidate as { default?: unknown }).default
      : undefined;
  return typeof nestedCandidate === "function" ? (nestedCandidate as ExtensionFactory) : undefined;
}

function isJavaScriptExtensionPath(extensionPath: string): boolean {
  switch (path.extname(extensionPath).toLowerCase()) {
    case ".cjs":
    case ".mjs":
      return true;
    default:
      return false;
  }
}

function extensionSourceNeedsJitiAliasResolution(extensionPath: string): boolean {
  try {
    const source = fs.readFileSync(extensionPath, "utf8");
    return (
      EXTENSION_LOADER_ALIAS_IMPORT_PATTERN.test(source) ||
      RELATIVE_EXTENSION_IMPORT_PATTERN.test(source) ||
      (path.extname(extensionPath).toLowerCase() === ".js" &&
        COMMONJS_EXTENSION_EXPORT_PATTERN.test(source))
    );
  } catch {
    return true;
  }
}

function shouldLoadExtensionWithNativeImport(extensionPath: string): boolean {
  return (
    !isBunBinary &&
    isJavaScriptExtensionPath(extensionPath) &&
    !extensionSourceNeedsJitiAliasResolution(extensionPath)
  );
}

async function loadNativeExtensionModule(
  extensionPath: string,
): Promise<ExtensionFactory | undefined> {
  const url = pathToFileURL(extensionPath);
  url.searchParams.set("v", String(++nativeExtensionLoadCounter));
  try {
    const cachedPath = require.resolve(extensionPath);
    delete require.cache[cachedPath];
  } catch {
    // ESM-only entries are not present in require's cache.
  }
  return resolveExtensionFactory(await import(url.href));
}

async function loadExtensionSourceTransformModule(
  extensionPath: string,
  context: ExtensionLoadContext,
): Promise<ExtensionFactory | undefined> {
  if (!context.sourceTransformLoader) {
    installOpenClawInternalCorePackageNativeResolver({ moduleUrl: import.meta.url });
    const createJitiLoader = await loadCreateJitiLoaderFactory();
    context.sourceTransformLoader = createJitiLoader(import.meta.url, {
      ...(isBunBinary
        ? {
            ...buildPluginLoaderJitiOptions({}),
            // Bun binaries need virtual modules because extension SDK files are
            // bundled into the executable rather than present on disk.
            virtualModules: VIRTUAL_MODULES,
          }
        : buildPluginLoaderJitiOptions(getExtensionLoaderAliases())),
      // Extension entry modules must bypass the native ESM cache so an explicit
      // reload observes edited source. Product modules stay native via nativeModules.
      tryNative: false,
      moduleCache: false,
    });
  }

  return resolveExtensionFactory(
    await context.sourceTransformLoader.import(extensionPath, { default: true }),
  );
}

async function loadExtensionModule(
  extensionPath: string,
  context: ExtensionLoadContext,
): Promise<ExtensionFactory | undefined> {
  if (isCurrentCacheScope(context.cacheScope)) {
    const cachedFactory = extensionFactoryCache.get(extensionPath);
    if (cachedFactory) {
      return cachedFactory;
    }
  }

  const factory = shouldLoadExtensionWithNativeImport(extensionPath)
    ? await loadNativeExtensionModule(extensionPath)
    : await loadExtensionSourceTransformModule(extensionPath, context);
  if (factory && isCurrentCacheScope(context.cacheScope)) {
    extensionFactoryCache.set(extensionPath, factory);
  }
  return factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
  const source =
    extensionPath.startsWith("<") && extensionPath.endsWith(">")
      ? extensionPath.slice(1, -1).split(":")[0] || "temporary"
      : "local";
  const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

  return {
    path: extensionPath,
    resolvedPath,
    sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

async function loadExtension(
  extensionPath: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  context: ExtensionLoadContext,
): Promise<{ extension: Extension | null; error: string | null }> {
  const resolvedPath = resolvePath(extensionPath, cwd);

  try {
    const factory = await loadExtensionModule(resolvedPath, context);
    if (!factory) {
      return {
        extension: null,
        error: `Extension does not export a valid factory function: ${extensionPath}`,
      };
    }

    const extension = createExtension(extensionPath, resolvedPath);
    const api = createExtensionAPI(extension, runtime, cwd, eventBus);
    await factory(api);

    return { extension, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { extension: null, error: `Failed to load extension: ${message}` };
  }
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
  factory: ExtensionFactory,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  extensionPath = "<inline>",
): Promise<Extension> {
  const extension = createExtension(extensionPath, extensionPath);
  const api = createExtensionAPI(extension, runtime, cwd, eventBus);
  await factory(api);
  return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensionsCached(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const resolvedEventBus = eventBus ?? createEventBus();
  const runtime = createExtensionRuntime();
  const cacheScope = useExtensionCacheCwd(cwd);
  const resolvedCwd = cacheScope.cwd;
  const context: ExtensionLoadContext = { cacheScope };

  for (const extPath of paths) {
    const { extension, error } = await loadExtension(
      extPath,
      resolvedCwd,
      resolvedEventBus,
      runtime,
      context,
    );

    if (error) {
      errors.push({ path: extPath, error });
      continue;
    }

    if (extension) {
      extensions.push(extension);
    }
  }

  return {
    extensions,
    errors,
    runtime,
  };
}
