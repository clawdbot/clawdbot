/**
 * Project Context Explorer
 *
 * Manages cached project context for Claude Code planning.
 * Explores projects to understand their structure, conventions, and preferences.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ProjectContext, ExplorationResult } from "../types.js";
import { getProjectsBase } from "./resolver.js";

/** Logger interface */
interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Default console logger */
const defaultLogger: Logger = {
  info: (msg) => console.log(`[claude-code/context] ${msg}`),
  warn: (msg) => console.warn(`[claude-code/context] ${msg}`),
  error: (msg) => console.error(`[claude-code/context] ${msg}`),
  debug: () => {},
};

let log: Logger = defaultLogger;

/** How old context can be before it's considered stale (default: 7 days) */
let stalenessThresholdMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Set the logger for the context explorer.
 */
export function setLogger(logger: Logger): void {
  log = logger;
}

/**
 * Set the staleness threshold in days.
 */
export function setStalenessDays(days: number): void {
  stalenessThresholdMs = days * 24 * 60 * 60 * 1000;
}

/**
 * Get the context directory path for a project.
 */
export function getProjectContextDir(projectName: string): string {
  return path.join(getProjectsBase(), projectName);
}

/**
 * Get the context.yaml path for a project.
 */
export function getContextPath(projectName: string): string {
  return path.join(getProjectContextDir(projectName), "context.yaml");
}

/**
 * Check if context exists for a project.
 */
export function hasProjectContext(projectName: string): boolean {
  return fs.existsSync(getContextPath(projectName));
}

/**
 * Check if context is stale (older than threshold).
 */
export function isContextStale(context: ProjectContext): boolean {
  if (!context.lastExplored) return true;
  const lastExplored = new Date(context.lastExplored).getTime();
  return Date.now() - lastExplored > stalenessThresholdMs;
}

/**
 * Load project context from disk.
 */
export function loadProjectContext(projectName: string): ProjectContext | null {
  const contextPath = getContextPath(projectName);

  if (!fs.existsSync(contextPath)) {
    log.debug(`No context found for project: ${projectName}`);
    return null;
  }

  try {
    const content = fs.readFileSync(contextPath, "utf-8");
    const context = parseYaml(content) as ProjectContext;
    log.debug(`Loaded context for project: ${projectName}`);
    return context;
  } catch (err) {
    log.error(`Failed to load context for ${projectName}: ${err}`);
    return null;
  }
}

/**
 * Save project context to disk.
 */
export function saveProjectContext(context: ProjectContext): void {
  const contextDir = getProjectContextDir(context.name);
  const contextPath = getContextPath(context.name);

  // Ensure directory exists
  if (!fs.existsSync(contextDir)) {
    fs.mkdirSync(contextDir, { recursive: true });
  }

  try {
    const content = stringifyYaml(context, { lineWidth: 100 });
    fs.writeFileSync(contextPath, content, "utf-8");
    log.info(`Saved context for project: ${context.name}`);
  } catch (err) {
    log.error(`Failed to save context for ${context.name}: ${err}`);
    throw err;
  }
}

/**
 * Detect project type from files.
 */
function detectProjectType(projectPath: string): string | undefined {
  const checks: Array<{ file: string; type: string }> = [
    { file: "package.json", type: "Node.js" },
    { file: "Cargo.toml", type: "Rust" },
    { file: "go.mod", type: "Go" },
    { file: "pyproject.toml", type: "Python" },
    { file: "requirements.txt", type: "Python" },
    { file: "Gemfile", type: "Ruby" },
    { file: "composer.json", type: "PHP" },
    { file: "pom.xml", type: "Java Maven" },
    { file: "build.gradle", type: "Java Gradle" },
  ];

  let baseType: string | undefined;

  for (const check of checks) {
    if (fs.existsSync(path.join(projectPath, check.file))) {
      baseType = check.type;
      break;
    }
  }

  if (!baseType) return undefined;

  // Refine for Node.js projects
  if (baseType === "Node.js") {
    const hasReact =
      fs.existsSync(path.join(projectPath, "src/App.tsx")) ||
      fs.existsSync(path.join(projectPath, "src/App.jsx")) ||
      fs.existsSync(path.join(projectPath, "app/page.tsx"));
    const hasTypeScript = fs.existsSync(path.join(projectPath, "tsconfig.json"));
    const hasNext =
      fs.existsSync(path.join(projectPath, "next.config.js")) ||
      fs.existsSync(path.join(projectPath, "next.config.mjs"));
    const hasVue = fs.existsSync(path.join(projectPath, "src/App.vue"));

    if (hasNext) {
      return hasTypeScript ? "Next.js + TypeScript" : "Next.js";
    }
    if (hasReact) {
      return hasTypeScript ? "React + TypeScript" : "React";
    }
    if (hasVue) {
      return hasTypeScript ? "Vue + TypeScript" : "Vue";
    }
    if (hasTypeScript) {
      return "Node.js + TypeScript";
    }
  }

  return baseType;
}

/**
 * Detect package manager.
 */
function detectPackageManager(projectPath: string): string | undefined {
  if (fs.existsSync(path.join(projectPath, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(projectPath, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(projectPath, "Cargo.lock"))) return "cargo";
  if (fs.existsSync(path.join(projectPath, "poetry.lock"))) return "poetry";
  if (fs.existsSync(path.join(projectPath, "Pipfile.lock"))) return "pipenv";
  if (fs.existsSync(path.join(projectPath, "go.sum"))) return "go mod";
  return undefined;
}

/**
 * Detect test framework.
 */
function detectTestFramework(projectPath: string): string | undefined {
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return "vitest";
      if (deps.jest) return "jest";
      if (deps.mocha) return "mocha";
      if (deps.ava) return "ava";
    } catch {
      // Ignore parse errors
    }
  }

  // Check for pytest
  if (
    fs.existsSync(path.join(projectPath, "pytest.ini")) ||
    fs.existsSync(path.join(projectPath, "conftest.py"))
  ) {
    return "pytest";
  }

  return undefined;
}

/**
 * Detect build tool.
 */
function detectBuildTool(projectPath: string): string | undefined {
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vite) return "vite";
      if (deps.webpack) return "webpack";
      if (deps.esbuild) return "esbuild";
      if (deps.rollup) return "rollup";
      if (deps.parcel) return "parcel";
      if (deps.turbo) return "turborepo";
    } catch {
      // Ignore parse errors
    }
  }

  if (fs.existsSync(path.join(projectPath, "tsconfig.json"))) {
    return "tsc";
  }

  return undefined;
}

/**
 * Scan directory structure and describe key folders.
 */
function scanStructure(projectPath: string): Record<string, string> {
  const structure: Record<string, string> = {};

  const knownDirs: Record<string, string> = {
    src: "Source code",
    "src/components": "React/Vue components",
    "src/hooks": "Custom hooks",
    "src/context": "React contexts",
    "src/utils": "Utility functions",
    "src/lib": "Library code",
    "src/api": "API routes/handlers",
    "src/services": "Service layer",
    "src/styles": "Stylesheets",
    app: "Next.js app router",
    pages: "Next.js pages router",
    components: "Components (root level)",
    lib: "Library code",
    utils: "Utilities",
    tests: "Test files",
    __tests__: "Jest test files",
    test: "Test files",
    spec: "Spec files",
    docs: "Documentation",
    scripts: "Build/utility scripts",
    config: "Configuration files",
    public: "Static assets",
    assets: "Asset files",
    dist: "Build output",
    build: "Build output",
    ".github": "GitHub workflows",
  };

  for (const [dir, description] of Object.entries(knownDirs)) {
    const fullPath = path.join(projectPath, dir);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      structure[`${dir}/`] = description;
    }
  }

  return structure;
}

/**
 * Infer coding conventions from project.
 */
function inferConventions(projectPath: string): string[] {
  const conventions: string[] = [];

  // Check for ESLint/Prettier/Biome
  if (
    fs.existsSync(path.join(projectPath, ".eslintrc.js")) ||
    fs.existsSync(path.join(projectPath, ".eslintrc.json")) ||
    fs.existsSync(path.join(projectPath, "eslint.config.js"))
  ) {
    conventions.push("Uses ESLint for linting");
  }
  if (
    fs.existsSync(path.join(projectPath, ".prettierrc")) ||
    fs.existsSync(path.join(projectPath, ".prettierrc.json"))
  ) {
    conventions.push("Uses Prettier for formatting");
  }
  if (fs.existsSync(path.join(projectPath, "biome.json"))) {
    conventions.push("Uses Biome for linting and formatting");
  }

  // Check for TypeScript strictness
  const tsconfigPath = path.join(projectPath, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    try {
      const content = fs.readFileSync(tsconfigPath, "utf-8");
      if (content.includes('"strict": true') || content.includes('"strict":true')) {
        conventions.push("TypeScript strict mode enabled");
      }
    } catch {
      // Ignore
    }
  }

  // Check test location
  if (fs.existsSync(path.join(projectPath, "__tests__"))) {
    conventions.push("Tests in __tests__ directories");
  } else if (fs.existsSync(path.join(projectPath, "tests"))) {
    conventions.push("Tests in tests/ directory");
  } else if (fs.existsSync(path.join(projectPath, "src"))) {
    try {
      const srcFiles = fs.readdirSync(path.join(projectPath, "src"));
      if (srcFiles.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))) {
        conventions.push("Tests colocated with source files");
      }
    } catch {
      // Ignore
    }
  }

  // Check for CSS approach
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.tailwindcss) conventions.push("Uses Tailwind CSS");
      if (deps["styled-components"]) conventions.push("Uses styled-components");
      if (deps["@emotion/react"]) conventions.push("Uses Emotion CSS-in-JS");
      if (deps.sass || deps["node-sass"]) conventions.push("Uses Sass/SCSS");
    } catch {
      // Ignore
    }
  }

  return conventions;
}

/**
 * Read CLAUDE.md or AGENTS.md if present.
 */
function readProjectDocs(projectPath: string): { claudeMd?: string; agentsMd?: string } {
  const result: { claudeMd?: string; agentsMd?: string } = {};

  const claudeMdPath = path.join(projectPath, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    try {
      result.claudeMd = fs.readFileSync(claudeMdPath, "utf-8");
    } catch {
      // Ignore
    }
  }

  const agentsMdPath = path.join(projectPath, "AGENTS.md");
  if (fs.existsSync(agentsMdPath)) {
    try {
      result.agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
    } catch {
      // Ignore
    }
  }

  return result;
}

/**
 * Explore a project and build context.
 */
export function exploreProject(projectPath: string, projectName?: string): ProjectContext {
  const resolvedPath = path.resolve(projectPath);
  const name = projectName || path.basename(resolvedPath);

  log.info(`Exploring project: ${name} at ${resolvedPath}`);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Project path does not exist: ${resolvedPath}`);
  }

  const docs = readProjectDocs(resolvedPath);

  const context: ProjectContext = {
    name,
    path: resolvedPath,
    lastExplored: new Date().toISOString(),
    type: detectProjectType(resolvedPath),
    packageManager: detectPackageManager(resolvedPath),
    testFramework: detectTestFramework(resolvedPath),
    buildTool: detectBuildTool(resolvedPath),
    structure: scanStructure(resolvedPath),
    conventions: inferConventions(resolvedPath),
    claudeMd: docs.claudeMd,
    agentsMd: docs.agentsMd,
    preferences: [],
  };

  // Save the context
  saveProjectContext(context);

  log.info(`Exploration complete for ${name}: ${context.type || "unknown type"}`);

  return context;
}

/**
 * Load or explore project context (hybrid approach).
 */
export function loadOrExploreProject(
  projectPath: string,
  projectName?: string,
  forceRefresh = false,
): ExplorationResult {
  const name = projectName || path.basename(path.resolve(projectPath));

  // Try to load existing context
  const existing = loadProjectContext(name);

  if (existing && !forceRefresh) {
    const stale = isContextStale(existing);

    if (!stale) {
      return { context: existing, isNew: false, wasStale: false };
    }

    // Context is stale, refresh it
    log.info(`Context for ${name} is stale, refreshing...`);
    const refreshed = exploreProject(projectPath, name);

    // Preserve learned preferences from old context
    refreshed.preferences = existing.preferences;
    refreshed.recentSessions = existing.recentSessions;

    saveProjectContext(refreshed);

    return { context: refreshed, isNew: false, wasStale: true };
  }

  // No existing context or force refresh
  const context = exploreProject(projectPath, name);
  return { context, isNew: true, wasStale: false };
}

/**
 * Update project context with new information.
 */
export function updateProjectContext(
  projectName: string,
  updates: Partial<Pick<ProjectContext, "preferences" | "recentSessions">>,
): ProjectContext | null {
  const context = loadProjectContext(projectName);
  if (!context) {
    log.warn(`Cannot update non-existent context: ${projectName}`);
    return null;
  }

  if (updates.preferences) {
    // Merge preferences, avoiding duplicates
    const existingSet = new Set(context.preferences);
    for (const pref of updates.preferences) {
      if (!existingSet.has(pref)) {
        context.preferences.push(pref);
      }
    }
  }

  if (updates.recentSessions) {
    context.recentSessions = context.recentSessions || [];
    context.recentSessions.push(...updates.recentSessions);
    // Keep only last 10 sessions
    if (context.recentSessions.length > 10) {
      context.recentSessions = context.recentSessions.slice(-10);
    }
  }

  saveProjectContext(context);
  return context;
}

/**
 * List all projects with context.
 */
export function listProjectsWithContext(): string[] {
  const projectsBase = getProjectsBase();
  if (!fs.existsSync(projectsBase)) {
    return [];
  }

  return fs.readdirSync(projectsBase).filter((name) => {
    const contextPath = path.join(projectsBase, name, "context.yaml");
    return fs.existsSync(contextPath);
  });
}

/**
 * Format context for display/prompt inclusion.
 */
export function formatContextForPrompt(context: ProjectContext): string {
  const lines: string[] = [];

  lines.push(`## Project: ${context.name}`);
  lines.push(`Path: ${context.path}`);
  if (context.type) lines.push(`Type: ${context.type}`);
  if (context.packageManager) lines.push(`Package Manager: ${context.packageManager}`);
  if (context.testFramework) lines.push(`Test Framework: ${context.testFramework}`);

  if (Object.keys(context.structure).length > 0) {
    lines.push("");
    lines.push("### Structure");
    for (const [dir, desc] of Object.entries(context.structure)) {
      lines.push(`- \`${dir}\`: ${desc}`);
    }
  }

  if (context.conventions.length > 0) {
    lines.push("");
    lines.push("### Conventions");
    for (const conv of context.conventions) {
      lines.push(`- ${conv}`);
    }
  }

  if (context.preferences.length > 0) {
    lines.push("");
    lines.push("### User Preferences");
    for (const pref of context.preferences) {
      lines.push(`- ${pref}`);
    }
  }

  if (context.claudeMd) {
    lines.push("");
    lines.push("### CLAUDE.md Contents");
    lines.push("```");
    lines.push(context.claudeMd.slice(0, 2000));
    if (context.claudeMd.length > 2000) lines.push("... (truncated)");
    lines.push("```");
  }

  return lines.join("\n");
}
