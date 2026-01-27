import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { VoiceCallTtsConfig } from "./config.js";

export type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};

type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentIdentity: (
    cfg: CoreConfig,
    agentId: string,
  ) => { name?: string | null } | null | undefined;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (
    storePath: string,
    store: Record<string, unknown>,
  ) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore parse errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveMoltbotRoot(): string {
  if (coreRootCache) return coreRootCache;
  const override = process.env.MOLTBOT_ROOT?.trim() || process.env.CLAWDBOT_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    const urlPath = fileURLToPath(import.meta.url);
    candidates.add(path.dirname(urlPath));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    for (const name of ["moltbot", "moltbot"]) {
      const found = findPackageRoot(start, name);
      if (found) {
        coreRootCache = found;
        return found;
      }
    }
  }

  throw new Error(
    "Unable to resolve core root. Set MOLTBOT_ROOT (or legacy CLAWDBOT_ROOT) to the package root.",
  );
}

async function importCoreModule<T>(relativePath: string): Promise<T> {
  const root = resolveMoltbotRoot();
  const distPath = path.join(root, "dist", relativePath);
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
    );
  }
  return (await import(pathToFileURL(distPath).href)) as T;
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const [
      agentScope,
      defaults,
      identity,
      modelSelection,
      piEmbedded,
      timeout,
      workspace,
      sessions,
    ] = await Promise.all([
      importCoreModule<{
        resolveAgentDir: CoreAgentDeps["resolveAgentDir"];
        resolveAgentWorkspaceDir: CoreAgentDeps["resolveAgentWorkspaceDir"];
      }>("agents/agent-scope.js"),
      importCoreModule<{
        DEFAULT_MODEL: string;
        DEFAULT_PROVIDER: string;
      }>("agents/defaults.js"),
      importCoreModule<{
        resolveAgentIdentity: CoreAgentDeps["resolveAgentIdentity"];
      }>("agents/identity.js"),
      importCoreModule<{
        resolveThinkingDefault: CoreAgentDeps["resolveThinkingDefault"];
      }>("agents/model-selection.js"),
      importCoreModule<{
        runEmbeddedPiAgent: CoreAgentDeps["runEmbeddedPiAgent"];
      }>("agents/pi-embedded.js"),
      importCoreModule<{
        resolveAgentTimeoutMs: CoreAgentDeps["resolveAgentTimeoutMs"];
      }>("agents/timeout.js"),
      importCoreModule<{
        ensureAgentWorkspace: CoreAgentDeps["ensureAgentWorkspace"];
      }>("agents/workspace.js"),
      importCoreModule<{
        resolveStorePath: CoreAgentDeps["resolveStorePath"];
        loadSessionStore: CoreAgentDeps["loadSessionStore"];
        saveSessionStore: CoreAgentDeps["saveSessionStore"];
        resolveSessionFilePath: CoreAgentDeps["resolveSessionFilePath"];
      }>("config/sessions.js"),
    ]);

    return {
      resolveAgentDir: agentScope.resolveAgentDir,
      resolveAgentWorkspaceDir: agentScope.resolveAgentWorkspaceDir,
      resolveAgentIdentity: identity.resolveAgentIdentity,
      resolveThinkingDefault: modelSelection.resolveThinkingDefault,
      runEmbeddedPiAgent: piEmbedded.runEmbeddedPiAgent,
      resolveAgentTimeoutMs: timeout.resolveAgentTimeoutMs,
      ensureAgentWorkspace: workspace.ensureAgentWorkspace,
      resolveStorePath: sessions.resolveStorePath,
      loadSessionStore: sessions.loadSessionStore,
      saveSessionStore: sessions.saveSessionStore,
      resolveSessionFilePath: sessions.resolveSessionFilePath,
      DEFAULT_MODEL: defaults.DEFAULT_MODEL,
      DEFAULT_PROVIDER: defaults.DEFAULT_PROVIDER,
    };
  })();

  return coreDepsPromise;
}
