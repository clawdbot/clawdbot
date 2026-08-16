import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { CodexThread } from "./protocol.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";

type CreatedCodexImportedSession = Awaited<
  ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>
>;

/** Creates a session whose transcript is derived from one verified Codex thread snapshot. */
export async function createImportedCodexSession(params: {
  runtime: PluginRuntime;
  config: OpenClawConfig;
  key: string;
  agentId: string;
  thread: CodexThread;
  throughTurnId: string | null;
  recoverMatchingInitialEntry?: true;
  initialEntry: {
    agentHarnessId: string;
    modelSelectionLocked?: true;
    pluginExtensions?: CreatedCodexImportedSession["entry"]["pluginExtensions"];
  };
  afterImport: (
    created: CreatedCodexImportedSession,
  ) => Promise<{ pluginExtensions: CreatedCodexImportedSession["entry"]["pluginExtensions"] }>;
}): Promise<CreatedCodexImportedSession> {
  const label = params.thread.name?.trim() || undefined;
  const spawnedCwd = params.thread.cwd?.trim() || undefined;
  const createParams = {
    cfg: params.config,
    key: params.key,
    agentId: params.agentId,
    ...(label ? { label } : {}),
    ...(spawnedCwd ? { spawnedCwd } : {}),
    initialEntry: params.initialEntry,
    afterCreate: async (entry: CreatedCodexImportedSession) => {
      // Post-flip the mirror targets SQLite rows; resolve the agent's store
      // path instead of trusting the legacy sessionFile locator marker.
      const storePath = resolveStorePath(params.config.session?.store, {
        agentId: entry.agentId,
      });
      await importCodexThreadHistoryToTranscript({
        thread: params.thread,
        throughTurnId: params.throughTurnId,
        storePath,
        sessionId: entry.sessionId,
        sessionKey: entry.key,
        agentId: entry.agentId,
        ...(spawnedCwd ? { cwd: spawnedCwd } : {}),
        modelProvider: params.thread.modelProvider,
        config: params.config,
      });
      return await params.afterImport(entry);
    },
  };
  return params.recoverMatchingInitialEntry
    ? await params.runtime.agent.session.createSessionEntry({
        ...createParams,
        recoverMatchingInitialEntry: true,
      })
    : await params.runtime.agent.session.createSessionEntry(createParams);
}
