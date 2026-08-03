/**
 * Session resource loader.
 *
 * Loads extensions, skills, prompts, themes, AGENTS files, and system prompt fragments for a cwd.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import chalk from "chalk";
import type { Skill } from "../../skills/loading/session.js";
import { loadSkills } from "../../skills/loading/session.js";
import { CONFIG_DIR_NAME } from "../config.js";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.js";
import { canonicalizePath, isLocalPath } from "../utils/paths.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createEventBus, type EventBus } from "./event-bus.js";
import {
  clearExtensionCache,
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensionsCached,
} from "./extensions/loader.js";
import type {
  Extension,
  ExtensionFactory,
  ExtensionRuntime,
  LoadExtensionsResult,
} from "./extensions/types.js";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.js";
import type { PromptTemplate } from "./prompt-templates.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { SettingsManager } from "./settings-manager.js";
import { createSourceInfo, type SourceInfo } from "./source-info.js";

export interface ResourceExtensionPaths {
  skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
  promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
  themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
  getExtensions(): LoadExtensionsResult;
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  extendResources(paths: ResourceExtensionPaths): void;
  reload(): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
  if (!input) {
    return undefined;
  }

  if (existsSync(input)) {
    try {
      return readFileSync(input, "utf-8");
    } catch (error) {
      console.error(
        chalk.yellow(`Warning: Could not read ${description} file ${input}: ${String(error)}`),
      );
      return undefined;
    }
  }

  return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
  const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return {
          path: filePath,
          content: readFileSync(filePath, "utf-8"),
        };
      } catch (error) {
        console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${String(error)}`));
      }
    }
  }
  return null;
}

function loadProjectContextFiles(options: {
  cwd: string;
  agentDir: string;
}): Array<{ path: string; content: string }> {
  const resolvedCwd = options.cwd;
  const resolvedAgentDir = options.agentDir;

  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  const globalContext = loadContextFileFromDir(resolvedAgentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  const ancestorContextFiles: Array<{ path: string; content: string }> = [];

  let currentDir = resolvedCwd;
  const root = resolve("/");

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    if (currentDir === root) {
      break;
    }

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);

  return contextFiles;
}

interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  eventBus?: EventBus;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  extensionFactories?: ExtensionFactory[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
  themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
    themes: Theme[];
    diagnostics: ResourceDiagnostic[];
  };
  agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  systemPromptTransform?: (base: string | undefined) => string | undefined;
  appendSystemPromptTransform?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
  private cwd: string;
  private agentDir: string;
  private settingsManager: SettingsManager;
  private eventBus: EventBus;
  private packageManager: DefaultPackageManager;
  private additionalExtensionPaths: string[];
  private additionalSkillPaths: string[];
  private additionalPromptTemplatePaths: string[];
  private additionalThemePaths: string[];
  private extensionFactories: ExtensionFactory[];
  private noExtensions: boolean;
  private noSkills: boolean;
  private noPromptTemplates: boolean;
  private noThemes: boolean;
  private noContextFiles: boolean;
  private systemPromptSource?: string;
  private appendSystemPromptSource?: string[];
  private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  private promptsOverride?: (base: {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  }) => {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
  private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
    themes: Theme[];
    diagnostics: ResourceDiagnostic[];
  };
  private agentsFilesOverride?: (base: {
    agentsFiles: Array<{ path: string; content: string }>;
  }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  private systemPromptTransform?: (base: string | undefined) => string | undefined;
  private appendSystemPromptTransform?: (base: string[]) => string[];

  private extensionsResult: LoadExtensionsResult;
  private skills: Skill[];
  private skillDiagnostics: ResourceDiagnostic[];
  private prompts: PromptTemplate[];
  private promptDiagnostics: ResourceDiagnostic[];
  private themes: Theme[];
  private themeDiagnostics: ResourceDiagnostic[];
  private agentsFiles: Array<{ path: string; content: string }>;
  private systemPrompt?: string;
  private appendSystemPrompt: string[];
  private lastSkillPaths: string[];
  private extensionSkillSourceInfos: Map<string, SourceInfo>;
  private extensionPromptSourceInfos: Map<string, SourceInfo>;
  private extensionThemeSourceInfos: Map<string, SourceInfo>;
  private lastPromptPaths: string[];
  private lastThemePaths: string[];
  private loaded = false;

  constructor(options: DefaultResourceLoaderOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.settingsManager =
      options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
    this.eventBus = options.eventBus ?? createEventBus();
    this.packageManager = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
    });
    this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
    this.additionalSkillPaths = options.additionalSkillPaths ?? [];
    this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
    this.additionalThemePaths = options.additionalThemePaths ?? [];
    this.extensionFactories = options.extensionFactories ?? [];
    this.noExtensions = options.noExtensions ?? false;
    this.noSkills = options.noSkills ?? false;
    this.noPromptTemplates = options.noPromptTemplates ?? false;
    this.noThemes = options.noThemes ?? false;
    this.noContextFiles = options.noContextFiles ?? false;
    this.systemPromptSource = options.systemPrompt;
    this.appendSystemPromptSource = options.appendSystemPrompt;
    this.extensionsOverride = options.extensionsOverride;
    this.skillsOverride = options.skillsOverride;
    this.promptsOverride = options.promptsOverride;
    this.themesOverride = options.themesOverride;
    this.agentsFilesOverride = options.agentsFilesOverride;
    this.systemPromptTransform = options.systemPromptTransform;
    this.appendSystemPromptTransform = options.appendSystemPromptTransform;

    this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
    this.skills = [];
    this.skillDiagnostics = [];
    this.prompts = [];
    this.promptDiagnostics = [];
    this.themes = [];
    this.themeDiagnostics = [];
    this.agentsFiles = [];
    this.appendSystemPrompt = [];
    this.lastSkillPaths = [];
    this.extensionSkillSourceInfos = new Map();
    this.extensionPromptSourceInfos = new Map();
    this.extensionThemeSourceInfos = new Map();
    this.lastPromptPaths = [];
    this.lastThemePaths = [];
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return { skills: this.skills, diagnostics: this.skillDiagnostics };
  }

  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
    return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
  }

  getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
    return { themes: this.themes, diagnostics: this.themeDiagnostics };
  }

  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
    return { agentsFiles: this.agentsFiles };
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  getAppendSystemPrompt(): string[] {
    return this.appendSystemPrompt;
  }

  extendResources(paths: ResourceExtensionPaths): void {
    const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
    const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
    const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

    for (const entry of skillPaths) {
      this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
    }
    for (const entry of promptPaths) {
      this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
    }
    for (const entry of themePaths) {
      this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
    }

    if (skillPaths.length > 0) {
      this.lastSkillPaths = this.mergePaths(
        this.lastSkillPaths,
        skillPaths.map((entry) => entry.path),
      );
      this.updateSkillsFromPaths(this.lastSkillPaths);
    }

    if (promptPaths.length > 0) {
      this.lastPromptPaths = this.mergePaths(
        this.lastPromptPaths,
        promptPaths.map((entry) => entry.path),
      );
      this.updatePromptsFromPaths(this.lastPromptPaths);
    }

    if (themePaths.length > 0) {
      this.lastThemePaths = this.mergePaths(
        this.lastThemePaths,
        themePaths.map((entry) => entry.path),
      );
      this.updateThemesFromPaths(this.lastThemePaths);
    }
  }

  async reload(): Promise<void> {
    if (this.loaded) {
      clearExtensionCache();
    }
    await this.settingsManager.reload();
    const resolvedPaths = await this.packageManager.resolve();
    const cliExtensionPaths = await this.packageManager.resolveExtensionSources(
      this.additionalExtensionPaths,
      {
        temporary: true,
      },
    );
    const metadataByPath = new Map<string, PathMetadata>();

    this.extensionSkillSourceInfos = new Map();
    this.extensionPromptSourceInfos = new Map();
    this.extensionThemeSourceInfos = new Map();

    // Helper to extract enabled paths and store metadata
    const getEnabledResources = (
      resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
    ): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
      for (const r of resources) {
        if (!metadataByPath.has(r.path)) {
          metadataByPath.set(r.path, r.metadata);
        }
      }
      return resources.filter((r) => r.enabled);
    };

    const getEnabledPaths = (
      resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
    ): string[] => getEnabledResources(resources).map((r) => r.path);
    const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
    const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
    const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
    const enabledThemes = getEnabledPaths(resolvedPaths.themes);

    const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
      if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
        return resource.path;
      }
      try {
        const stats = statSync(resource.path);
        if (!stats.isDirectory()) {
          return resource.path;
        }
      } catch {
        return resource.path;
      }
      const skillFile = join(resource.path, "SKILL.md");
      if (existsSync(skillFile)) {
        if (!metadataByPath.has(skillFile)) {
          metadataByPath.set(skillFile, resource.metadata);
        }
        return skillFile;
      }
      return resource.path;
    };

    const enabledSkills = enabledSkillResources.map(mapSkillPath);

    // Add CLI paths metadata
    for (const r of cliExtensionPaths.extensions) {
      if (!metadataByPath.has(r.path)) {
        metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
      }
    }
    for (const r of cliExtensionPaths.skills) {
      if (!metadataByPath.has(r.path)) {
        metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
      }
    }

    const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
    const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
    const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
    const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

    const extensionPaths = this.noExtensions
      ? cliEnabledExtensions
      : this.mergePaths(cliEnabledExtensions, enabledExtensions);

    const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
    const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
    extensionsResult.extensions.push(...inlineExtensions.extensions);
    extensionsResult.errors.push(...inlineExtensions.errors);

    // Detect extension conflicts (tools, commands, flags with same names from different extensions)
    // Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
    const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
    for (const conflict of conflicts) {
      extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
    }

    for (const p of this.additionalExtensionPaths) {
      if (isLocalPath(p) && !existsSync(p)) {
        extensionsResult.errors.push({ path: p, error: `Extension path does not exist: ${p}` });
      }
    }
    this.extensionsResult = this.extensionsOverride
      ? this.extensionsOverride(extensionsResult)
      : extensionsResult;
    this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

    const skillPaths = this.noSkills
      ? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
      : this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

    this.lastSkillPaths = skillPaths;
    this.updateSkillsFromPaths(skillPaths, metadataByPath);
    for (const p of this.additionalSkillPaths) {
      if (isLocalPath(p) && !existsSync(p) && !this.skillDiagnostics.some((d) => d.path === p)) {
        this.skillDiagnostics.push({
          type: "error",
          message: "Skill path does not exist",
          path: p,
        });
      }
    }

    const promptPaths = this.noPromptTemplates
      ? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
      : this.mergePaths(
          [...cliEnabledPrompts, ...enabledPrompts],
          this.additionalPromptTemplatePaths,
        );

    this.lastPromptPaths = promptPaths;
    this.updatePromptsFromPaths(promptPaths, metadataByPath);
    for (const p of this.additionalPromptTemplatePaths) {
      if (isLocalPath(p) && !existsSync(p) && !this.promptDiagnostics.some((d) => d.path === p)) {
        this.promptDiagnostics.push({
          type: "error",
          message: "Prompt template path does not exist",
          path: p,
        });
      }
    }

    const themePaths = this.noThemes
      ? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
      : this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

    this.lastThemePaths = themePaths;
    this.updateThemesFromPaths(themePaths, metadataByPath);
    for (const p of this.additionalThemePaths) {
      if (!existsSync(p) && !this.themeDiagnostics.some((d) => d.path === p)) {
        this.themeDiagnostics.push({
          type: "error",
          message: "Theme path does not exist",
          path: p,
        });
      }
    }

    const agentsFiles = {
      agentsFiles: this.noContextFiles
        ? []
        : loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
    };
    const resolvedAgentsFiles = this.agentsFilesOverride
      ? this.agentsFilesOverride(agentsFiles)
      : agentsFiles;
    this.agentsFiles = resolvedAgentsFiles.agentsFiles;

    const baseSystemPrompt = resolvePromptInput(
      this.systemPromptSource ?? this.discoverSystemPromptFile(),
      "system prompt",
    );
    this.systemPrompt = this.systemPromptTransform
      ? this.systemPromptTransform(baseSystemPrompt)
      : baseSystemPrompt;

    const appendSources =
      this.appendSystemPromptSource ??
      (this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
    const baseAppend = appendSources
      .map((s) => resolvePromptInput(s, "append system prompt"))
      .filter((s): s is string => s !== undefined);
    this.appendSystemPrompt = this.appendSystemPromptTransform
      ? this.appendSystemPromptTransform(baseAppend)
      : baseAppend;
    this.loaded = true;
  }

  private normalizeExtensionPaths(
    entries: Array<{ path: string; metadata: PathMetadata }>,
  ): Array<{ path: string; metadata: PathMetadata }> {
    return entries.map((entry) => ({
      path: this.resolveResourcePath(entry.path),
      metadata: entry.metadata,
    }));
  }

  private updateSkillsFromPaths(
    skillPaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
    if (this.noSkills && skillPaths.length === 0) {
      skillsResult = { skills: [], diagnostics: [] };
    } else {
      skillsResult = loadSkills({
        cwd: this.cwd,
        agentDir: this.agentDir,
        skillPaths,
        includeDefaults: false,
      });
    }
    const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
    this.skills = resolvedSkills.skills.map((skill) => ({
      ...skill,
      sourceInfo:
        this.findSourceInfoForPath(
          skill.filePath,
          this.extensionSkillSourceInfos,
          metadataByPath,
        ) ??
        skill.sourceInfo ??
        this.getDefaultSourceInfoForPath(skill.filePath),
    }));
    this.skillDiagnostics = resolvedSkills.diagnostics;
  }

  private updatePromptsFromPaths(
    promptPaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
    if (this.noPromptTemplates && promptPaths.length === 0) {
      promptsResult = { prompts: [], diagnostics: [] };
    } else {
      const allPrompts = loadPromptTemplates({
        cwd: this.cwd,
        agentDir: this.agentDir,
        promptPaths,
        includeDefaults: false,
      });
      promptsResult = this.dedupePrompts(allPrompts);
    }
    const resolvedPrompts = this.promptsOverride
      ? this.promptsOverride(promptsResult)
      : promptsResult;
    this.prompts = resolvedPrompts.prompts.map((prompt) => ({
      ...prompt,
      sourceInfo:
        this.findSourceInfoForPath(
          prompt.filePath,
          this.extensionPromptSourceInfos,
          metadataByPath,
        ) ??
        prompt.sourceInfo ??
        this.getDefaultSourceInfoForPath(prompt.filePath),
    }));
    this.promptDiagnostics = resolvedPrompts.diagnostics;
  }

  private updateThemesFromPaths(
    themePaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
    if (this.noThemes && themePaths.length === 0) {
      themesResult = { themes: [], diagnostics: [] };
    } else {
      const loaded = this.loadThemes(themePaths, false);
      const deduped = this.dedupeThemes(loaded.themes);
      themesResult = {
        themes: deduped.themes,
        diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
      };
    }
    const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
    this.themes = resolvedThemes.themes.map((theme) => {
      const sourcePath = theme.sourcePath;
      theme.sourceInfo = sourcePath
        ? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
          theme.sourceInfo ??
          this.getDefaultSourceInfoForPath(sourcePath))
        : theme.sourceInfo;
      return theme;
    });
    this.themeDiagnostics = resolvedThemes.diagnostics;
  }

  private applyExtensionSourceInfo(
    extensions: Extension[],
    metadataByPath: Map<string, PathMetadata>,
  ): void {
    for (const extension of extensions) {
      extension.sourceInfo =
        this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
        this.getDefaultSourceInfoForPath(extension.path);
      for (const command of extension.commands.values()) {
        command.sourceInfo = extension.sourceInfo;
      }
      for (const tool of extension.tools.values()) {
        tool.sourceInfo = extension.sourceInfo;
      }
    }
  }

  private findSourceInfoForPath(
    resourcePath: string,
    extraSourceInfos?: Map<string, SourceInfo>,
    metadataByPath?: Map<string, PathMetadata>,
  ): SourceInfo | undefined {
    if (!resourcePath) {
      return undefined;
    }

    if (resourcePath.startsWith("<")) {
      return this.getDefaultSourceInfoForPath(resourcePath);
    }

    const normalizedResourcePath = resolve(resourcePath);
    if (extraSourceInfos) {
      for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
        const normalizedSourcePath = resolve(sourcePath);
        if (
          normalizedResourcePath === normalizedSourcePath ||
          normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
        ) {
          return { ...sourceInfo, path: resourcePath };
        }
      }
    }

    if (metadataByPath) {
      const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
      if (exact) {
        return createSourceInfo(resourcePath, exact);
      }

      for (const [sourcePath, metadata] of metadataByPath.entries()) {
        const normalizedSourcePath = resolve(sourcePath);
        if (
          normalizedResourcePath === normalizedSourcePath ||
          normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
        ) {
          return createSourceInfo(resourcePath, metadata);
        }
      }
    }

    return undefined;
  }

  private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
    if (filePath.startsWith("<") && filePath.endsWith(">")) {
      return {
        path: filePath,
        source: filePath.slice(1, -1).split(":")[0] || "temporary",
        scope: "temporary",
        origin: "top-level",
      };
    }

    const normalizedPath = resolve(filePath);
    const agentRoots = [
      join(this.agentDir, "skills"),
      join(this.agentDir, "prompts"),
      join(this.agentDir, "themes"),
      join(this.agentDir, "extensions"),
    ];
    const projectRoots = [
      join(this.cwd, CONFIG_DIR_NAME, "skills"),
      join(this.cwd, CONFIG_DIR_NAME, "prompts"),
      join(this.cwd, CONFIG_DIR_NAME, "themes"),
      join(this.cwd, CONFIG_DIR_NAME, "extensions"),
    ];

    for (const root of agentRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        return {
          path: filePath,
          source: "local",
          scope: "user",
          origin: "top-level",
          baseDir: root,
        };
      }
    }

    for (const root of projectRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        return {
          path: filePath,
          source: "local",
          scope: "project",
          origin: "top-level",
          baseDir: root,
        };
      }
    }

    return {
      path: filePath,
      source: "local",
      scope: "temporary",
      origin: "top-level",
      baseDir: statSync(normalizedPath).isDirectory()
        ? normalizedPath
        : resolve(normalizedPath, ".."),
    };
  }

  private mergePaths(primary: string[], additional: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const p of [...primary, ...additional]) {
      const resolved = this.resolveResourcePath(p);
      const canonicalPath = canonicalizePath(resolved);
      if (seen.has(canonicalPath)) {
        continue;
      }
      seen.add(canonicalPath);
      merged.push(resolved);
    }

    return merged;
  }

  private resolveResourcePath(p: string): string {
    const trimmed = p.trim();
    let expanded = trimmed;
    if (trimmed === "~") {
      expanded = homedir();
    } else if (trimmed.startsWith("~/")) {
      expanded = join(homedir(), trimmed.slice(2));
    } else if (trimmed.startsWith("~")) {
      expanded = join(homedir(), trimmed.slice(1));
    }
    return resolve(this.cwd, expanded);
  }

  private loadThemes(
    paths: string[],
    includeDefaults = true,
  ): {
    themes: Theme[];
    diagnostics: ResourceDiagnostic[];
  } {
    const themes: Theme[] = [];
    const diagnostics: ResourceDiagnostic[] = [];
    if (includeDefaults) {
      const defaultDirs = [
        join(this.agentDir, "themes"),
        join(this.cwd, CONFIG_DIR_NAME, "themes"),
      ];

      for (const dir of defaultDirs) {
        this.loadThemesFromDir(dir, themes, diagnostics);
      }
    }

    for (const p of paths) {
      const resolved = resolve(this.cwd, p);
      if (!existsSync(resolved)) {
        diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
        continue;
      }

      try {
        const stats = statSync(resolved);
        if (stats.isDirectory()) {
          this.loadThemesFromDir(resolved, themes, diagnostics);
        } else if (stats.isFile() && resolved.endsWith(".json")) {
          this.loadThemeFromFile(resolved, themes, diagnostics);
        } else {
          diagnostics.push({
            type: "warning",
            message: "theme path is not a json file",
            path: resolved,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to read theme path";
        diagnostics.push({ type: "warning", message, path: resolved });
      }
    }

    return { themes, diagnostics };
  }

  private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
    if (!existsSync(dir)) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            isFile = statSync(join(dir, entry.name)).isFile();
          } catch {
            continue;
          }
        }
        if (!isFile) {
          continue;
        }
        if (!entry.name.endsWith(".json")) {
          continue;
        }
        this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read theme directory";
      diagnostics.push({ type: "warning", message, path: dir });
    }
  }

  private loadThemeFromFile(
    filePath: string,
    themes: Theme[],
    diagnostics: ResourceDiagnostic[],
  ): void {
    try {
      themes.push(loadThemeFromPath(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to load theme";
      diagnostics.push({ type: "warning", message, path: filePath });
    }
  }

  private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
    extensions: Extension[];
    errors: Array<{ path: string; error: string }>;
  }> {
    const extensions: Extension[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        const extension = await loadExtensionFromFactory(
          factory,
          this.cwd,
          this.eventBus,
          runtime,
          extensionPath,
        );
        extensions.push(extension);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed to load extension";
        errors.push({ path: extensionPath, error: message });
      }
    }

    return { extensions, errors };
  }

  private dedupePrompts(prompts: PromptTemplate[]): {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  } {
    const seen = new Map<string, PromptTemplate>();
    const diagnostics: ResourceDiagnostic[] = [];

    for (const prompt of prompts) {
      const existing = seen.get(prompt.name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `name "/${prompt.name}" collision`,
          path: prompt.filePath,
          collision: {
            resourceType: "prompt",
            name: prompt.name,
            winnerPath: existing.filePath,
            loserPath: prompt.filePath,
          },
        });
      } else {
        seen.set(prompt.name, prompt);
      }
    }

    return { prompts: Array.from(seen.values()), diagnostics };
  }

  private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
    const seen = new Map<string, Theme>();
    const diagnostics: ResourceDiagnostic[] = [];

    for (const t of themes) {
      const name = t.name ?? "unnamed";
      const existing = seen.get(name);
      if (existing) {
        diagnostics.push({
          type: "collision",
          message: `name "${name}" collision`,
          path: t.sourcePath,
          collision: {
            resourceType: "theme",
            name,
            winnerPath: existing.sourcePath ?? "<builtin>",
            loserPath: t.sourcePath ?? "<builtin>",
          },
        });
      } else {
        seen.set(name, t);
      }
    }

    return { themes: Array.from(seen.values()), diagnostics };
  }

  private discoverSystemPromptFile(): string | undefined {
    const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
    if (existsSync(projectPath)) {
      return projectPath;
    }

    const globalPath = join(this.agentDir, "SYSTEM.md");
    if (existsSync(globalPath)) {
      return globalPath;
    }

    return undefined;
  }

  private discoverAppendSystemPromptFile(): string | undefined {
    const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
    if (existsSync(projectPath)) {
      return projectPath;
    }

    const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
    if (existsSync(globalPath)) {
      return globalPath;
    }

    return undefined;
  }

  private isUnderPath(target: string, root: string): boolean {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  }

  private detectExtensionConflicts(
    extensions: Extension[],
  ): Array<{ path: string; message: string }> {
    const conflicts: Array<{ path: string; message: string }> = [];

    // Track which extension registered each tool and flag
    const toolOwners = new Map<string, string>();
    const flagOwners = new Map<string, string>();

    for (const ext of extensions) {
      // Check tools
      for (const toolName of ext.tools.keys()) {
        const existingOwner = toolOwners.get(toolName);
        if (existingOwner && existingOwner !== ext.path) {
          conflicts.push({
            path: ext.path,
            message: `Tool "${toolName}" conflicts with ${existingOwner}`,
          });
        } else {
          toolOwners.set(toolName, ext.path);
        }
      }

      // Check flags
      for (const flagName of ext.flags.keys()) {
        const existingOwner = flagOwners.get(flagName);
        if (existingOwner && existingOwner !== ext.path) {
          conflicts.push({
            path: ext.path,
            message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
          });
        } else {
          flagOwners.set(flagName, ext.path);
        }
      }
    }

    return conflicts;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
