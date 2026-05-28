/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import * as bundledLlm from "openclaw/plugin-sdk/llm";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
} from "../../../plugins/sdk-alias.js";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.js";
import * as bundledAgentCore from "../../runtime/index.js";
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
const VIRTUAL_MODULES: Record<string, unknown> = {
  typebox: bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/value": bundledTypeboxValue,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
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
    "typebox/value": typeboxValueEntry,
    "@sinclair/typebox": typeboxEntry,
    "@sinclair/typebox/compile": typeboxCompileEntry,
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

async function loadExtensionModule(extensionPath: string) {
  const jiti = createJiti(import.meta.url, {
    ...(isBunBinary
      ? {
          ...buildPluginLoaderJitiOptions({}),
          // Bun binaries need virtual modules because extension SDK files are
          // bundled into the executable rather than present on disk.
          tryNative: false,
          virtualModules: VIRTUAL_MODULES,
        }
      : buildPluginLoaderJitiOptions(getExtensionLoaderAliases())),
    moduleCache: false,
  });

  const module = await jiti.import(extensionPath, { default: true });
  const factory = module as ExtensionFactory;
  return typeof factory !== "function" ? undefined : factory;
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
): Promise<{ extension: Extension | null; error: string | null }> {
  const resolvedPath = resolvePath(extensionPath, cwd);

  try {
    const factory = await loadExtensionModule(resolvedPath);
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
export async function loadExtensions(
  paths: string[],
  cwd: string,
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const resolvedEventBus = eventBus ?? createEventBus();
  const runtime = createExtensionRuntime();

  for (const extPath of paths) {
    const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

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

interface ResourceManifest {
  extensions?: string[];
  themes?: string[];
  skills?: string[];
  prompts?: string[];
}

function readResourceManifest(packageJsonPath: string): ResourceManifest | null {
  try {
    const content = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    if (pkg.openclaw && typeof pkg.openclaw === "object") {
      return pkg.openclaw as ResourceManifest;
    }
    return null;
  } catch {
    return null;
  }
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "openclaw.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
  // Check for package.json with "openclaw" field first
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const manifest = readResourceManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries: string[] = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = path.resolve(dir, extPath);
        if (fs.existsSync(resolvedExtPath)) {
          entries.push(resolvedExtPath);
        }
      }
      if (entries.length > 0) {
        return entries;
      }
    }
  }

  // Check for index.ts or index.js
  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexTs)) {
    return [indexTs];
  }
  if (fs.existsSync(indexJs)) {
    return [indexJs];
  }

  return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "openclaw" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const discovered: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      // 1. Direct files: *.ts or *.js
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }

      // 2 & 3. Subdirectories
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const entries = resolveExtensionEntries(entryPath);
        if (entries) {
          discovered.push(...entries);
        }
      }
    }
  } catch {
    return [];
  }

  return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
  configuredPaths: string[],
  cwd: string,
  agentDir: string = getAgentDir(),
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const allPaths: string[] = [];
  const seen = new Set<string>();

  const addPaths = (paths: string[]) => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        allPaths.push(p);
      }
    }
  };

  // 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
  const localExtDir = path.join(cwd, CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDir(localExtDir));

  // 2. Global extensions: agentDir/extensions/
  const globalExtDir = path.join(agentDir, "extensions");
  addPaths(discoverExtensionsInDir(globalExtDir));

  // 3. Explicitly configured paths
  for (const p of configuredPaths) {
    const resolved = resolvePath(p, cwd);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      // Check for package.json with OpenClaw manifest or index.ts
      const entries = resolveExtensionEntries(resolved);
      if (entries) {
        addPaths(entries);
        continue;
      }
      // No explicit entries - discover individual files in directory
      addPaths(discoverExtensionsInDir(resolved));
      continue;
    }

    addPaths([resolved]);
  }

  return loadExtensions(allPaths, cwd, eventBus);
}
