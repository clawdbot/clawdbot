import { basename, dirname } from "node:path";
import { AgentSessionCompaction } from "./agent-session-compaction.js";
import type { ExtensionBindings } from "./agent-session-types.js";
import { ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { ResourceExtensionPaths } from "./resource-loader.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";

type ToolDefinitionEntry = {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
};

export abstract class AgentSessionExtensions extends AgentSessionCompaction {
  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
    if (bindings.uiContext !== undefined) {
      this.extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== undefined) {
      this.extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.abortHandler !== undefined) {
      this.extensionAbortHandler = bindings.abortHandler;
    }
    if (bindings.shutdownHandler !== undefined) {
      this.extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== undefined) {
      this.extensionErrorListener = bindings.onError;
    }

    this.applyExtensionBindings(this.currentExtensionRunner);
    await this.currentExtensionRunner.emit(this.sessionStartEvent);
    await this.extendResourcesFromExtensions(
      this.sessionStartEvent.reason === "reload" ? "reload" : "startup",
    );
  }

  private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
    if (!this.currentExtensionRunner.hasHandlers("resources_discover")) {
      return;
    }

    const { skillPaths, promptPaths, themePaths } =
      await this.currentExtensionRunner.emitResourcesDiscover(this.cwd, reason);

    if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
      return;
    }

    const extensionPaths: ResourceExtensionPaths = {
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths),
    };

    this.sessionResourceLoader.extendResources(extensionPaths);
    this.baseSystemPrompt = this.rebuildSystemPrompt(this.getActiveToolNames());
    this.agent.state.systemPrompt = this.baseSystemPrompt;
  }

  private buildExtensionResourcePaths(
    entries: Array<{ path: string; extensionPath: string }>,
  ): Array<{
    path: string;
    metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
  }> {
    return entries.map((entry) => {
      const source = this.getExtensionSourceLabel(entry.extensionPath);
      const baseDir = entry.extensionPath.startsWith("<")
        ? undefined
        : dirname(entry.extensionPath);
      return {
        path: entry.path,
        metadata: {
          source,
          scope: "temporary",
          origin: "top-level",
          baseDir,
        },
      };
    });
  }

  private getExtensionSourceLabel(extensionPath: string): string {
    if (extensionPath.startsWith("<")) {
      return `extension:${extensionPath.replace(/[<>]/g, "")}`;
    }
    const base = basename(extensionPath);
    const name = base.replace(/\.(ts|js)$/, "");
    return `extension:${name}`;
  }

  private applyExtensionBindings(runner: ExtensionRunner): void {
    runner.setUIContext(this.extensionUIContext);
    runner.bindCommandContext(this.extensionCommandContextActions);

    this.extensionErrorUnsubscriber?.();
    this.extensionErrorUnsubscriber = this.extensionErrorListener
      ? runner.onError(this.extensionErrorListener)
      : undefined;
  }

  private refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this.sessionModelRegistry.find(currentModel.provider, currentModel.id);
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.state.model = refreshedModel;
  }

  private bindExtensionCore(runner: ExtensionRunner): void {
    const getCommands = (): SlashCommandInfo[] => {
      const extensionCommands: SlashCommandInfo[] = runner
        .getRegisteredCommands()
        .map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension",
          sourceInfo: command.sourceInfo,
        }));

      const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt",
        sourceInfo: template.sourceInfo,
      }));

      const skills: SlashCommandInfo[] = this.sessionResourceLoader
        .getSkills()
        .skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        }));

      return [...extensionCommands, ...templates, ...skills];
    };

    runner.bindCore(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err: unknown) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err: unknown) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_user_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        setSessionName: (name) => {
          this.setSessionName(name);
        },
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        refreshTools: () => this.refreshToolRegistry(),
        getCommands,
        setModel: async (model) => {
          if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
            return false;
          }
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level),
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        getSignal: () => this.agent.signal,
        abort: () => {
          if (this.extensionAbortHandler) {
            this.extensionAbortHandler();
            return;
          }
          void this.abort();
        },
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {
          this.extensionShutdownHandler?.();
        },
        getContextUsage: () => this.getContextUsage(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt,
      },
      {
        registerProvider: (name, config) => {
          this.sessionModelRegistry.registerProvider(name, config);
          this.refreshCurrentModelFromRegistry();
        },
        unregisterProvider: (name) => {
          this.sessionModelRegistry.unregisterProvider(name);
          this.refreshCurrentModelFromRegistry();
        },
      },
    );
  }

  private refreshToolRegistry(options?: {
    activeToolNames?: string[];
    includeAllExtensionTools?: boolean;
  }): void {
    const previousRegistryNames = new Set(this.toolRegistry.keys());
    const previousActiveToolNames = this.getActiveToolNames();
    const allowedToolNames = this.allowedToolNames;
    const isDisabledBuiltInToolName = (name: string): boolean =>
      this.disableBuiltInTools && this.baseToolDefinitions.has(name);
    const isAllowedTool = (name: string): boolean =>
      !isDisabledBuiltInToolName(name) && (!allowedToolNames || allowedToolNames.has(name));

    const registeredTools = this.currentExtensionRunner.getAllRegisteredTools();
    const allCustomTools = [
      ...registeredTools,
      ...this.customTools.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
      })),
    ].filter((tool) => isAllowedTool(tool.definition.name));
    const definitionRegistry = new Map<string, ToolDefinitionEntry>(
      Array.from(this.baseToolDefinitions.entries())
        .filter(([name]) => isAllowedTool(name))
        .map(([name, definition]) => [
          name,
          {
            definition,
            sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
          },
        ]),
    );
    for (const tool of allCustomTools) {
      definitionRegistry.set(tool.definition.name, {
        definition: tool.definition,
        sourceInfo: tool.sourceInfo,
      });
    }
    this.toolDefinitions = definitionRegistry;
    this.toolPromptSnippets = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const snippet = this.normalizePromptSnippet(definition.promptSnippet);
          return snippet ? ([definition.name, snippet] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string] => entry !== undefined),
    );
    this.toolPromptGuidelines = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const guidelines = this.normalizePromptGuidelines(definition.promptGuidelines);
          return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string[]] => entry !== undefined),
    );
    const runner = this.currentExtensionRunner;
    const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
    const wrappedBuiltInTools = wrapRegisteredTools(
      Array.from(this.baseToolDefinitions.values())
        .filter((definition) => isAllowedTool(definition.name))
        .map((definition) => ({
          definition,
          sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, {
            source: "builtin",
          }),
        })),
      runner,
    );

    const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
    for (const tool of wrappedExtensionTools) {
      toolRegistry.set(tool.name, tool);
    }
    this.toolRegistry = toolRegistry;

    const nextActiveToolNames = (
      options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
    ).filter((name) => isAllowedTool(name));

    if (allowedToolNames) {
      for (const toolName of this.toolRegistry.keys()) {
        if (allowedToolNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    } else if (options?.includeAllExtensionTools) {
      for (const tool of wrappedExtensionTools) {
        nextActiveToolNames.push(tool.name);
      }
    } else if (!options?.activeToolNames) {
      for (const toolName of this.toolRegistry.keys()) {
        if (!previousRegistryNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    }

    this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
  }

  protected buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
    includeAllExtensionTools?: boolean;
  }): void {
    const autoResizeImages = this.settingsManager.getImageAutoResize();
    const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
    const shellPath = this.settingsManager.getShellPath();
    const baseToolDefinitions = this.baseToolsOverride
      ? Object.fromEntries(
          Object.entries(this.baseToolsOverride).map(([name, tool]) => [
            name,
            createToolDefinitionFromAgentTool(tool),
          ]),
        )
      : createAllToolDefinitions(this.cwd, {
          read: { autoResizeImages },
          bash: { commandPrefix: shellCommandPrefix, shellPath },
        });

    this.baseToolDefinitions = new Map(
      Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
    );

    const extensionsResult = this.sessionResourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    this.currentExtensionRunner = new ExtensionRunner(
      extensionsResult.extensions,
      extensionsResult.runtime,
      this.cwd,
      this.sessionManager,
      this.sessionModelRegistry,
    );
    if (this.extensionRunnerRef) {
      this.extensionRunnerRef.current = this.currentExtensionRunner;
    }
    this.bindExtensionCore(this.currentExtensionRunner);
    this.applyExtensionBindings(this.currentExtensionRunner);

    const defaultActiveToolNames = this.baseToolsOverride
      ? Object.keys(this.baseToolsOverride)
      : ["read", "bash", "edit", "write"];
    const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
    this.refreshToolRegistry({
      activeToolNames: baseActiveToolNames,
      includeAllExtensionTools: options.includeAllExtensionTools,
    });
  }

  async reload(): Promise<void> {
    const previousFlagValues = this.currentExtensionRunner.getFlagValues();
    await emitSessionShutdownEvent(this.currentExtensionRunner, {
      type: "session_shutdown",
      reason: "reload",
    });
    await this.settingsManager.reload();
    this.agent.steeringMode = this.settingsManager.getSteeringMode();
    this.agent.followUpMode = this.settingsManager.getFollowUpMode();
    await this.sessionResourceLoader.reload();
    this.sessionModelRegistry.refresh();
    this.buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
      includeAllExtensionTools: true,
    });

    const hasBindings =
      this.extensionUIContext ||
      this.extensionCommandContextActions ||
      this.extensionShutdownHandler ||
      this.extensionErrorListener;
    if (hasBindings) {
      await this.currentExtensionRunner.emit({ type: "session_start", reason: "reload" });
      await this.extendResourcesFromExtensions("reload");
    }
  }
}
