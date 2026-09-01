import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type { CodexThread } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { prepareCodexSessionInitialization } from "./session-initialization.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";

type CreatedCodexImportedSession = Awaited<
  ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>
>;

/** Creates a session whose transcript is derived from one verified Codex thread snapshot. */
export async function createImportedCodexSession(params: {
  runtime: PluginRuntime;
  bindingStore: CodexAppServerBindingStore;
  prepareCleanup?: () => (assertCurrent: () => void) => Promise<void>;
  config: OpenClawConfig;
  key: string;
  agentId: string;
  // Adoption explicitly snapshots a title; native forks must not inherit one.
  displayName?: string;
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
    initialization: ReturnType<typeof prepareCodexSessionInitialization>,
  ) => Promise<{ pluginExtensions: CreatedCodexImportedSession["entry"]["pluginExtensions"] }>;
}): Promise<CreatedCodexImportedSession> {
  const spawnedCwd = params.thread.cwd?.trim() || undefined;
  const createParams = {
    cfg: params.config,
    key: params.key,
    agentId: params.agentId,
    ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
    ...(spawnedCwd ? { spawnedCwd } : {}),
    initialEntry: params.initialEntry,
    afterCreate: async (
      entry: CreatedCodexImportedSession & {
        initialization?: Parameters<typeof prepareCodexSessionInitialization>[0]["initialization"];
      },
    ) => {
      if (!entry.initialization) {
        throw new Error("Codex history initialization requires host creation authority");
      }
      const initialization = prepareCodexSessionInitialization({
        initialization: entry.initialization,
        bindingStore: params.bindingStore,
        identity: sessionBindingIdentity({
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          sessionKey: entry.key,
          config: params.config,
        }),
        prepareCleanup: params.prepareCleanup,
      });
      // Post-flip the mirror targets SQLite rows; resolve the agent's store
      // path instead of trusting the legacy sessionFile locator marker.
      const storePath = resolveStorePath(params.config.session?.store, {
        agentId: entry.agentId,
      });
      await importCodexThreadHistoryToTranscript({
        assertCurrent: entry.initialization.assertCurrent,
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
      entry.initialization.assertCurrent();
      return await params.afterImport(entry, initialization);
    },
  };
  return params.recoverMatchingInitialEntry
    ? await params.runtime.agent.session.createSessionEntry({
        ...createParams,
        recoverMatchingInitialEntry: true,
      })
    : await params.runtime.agent.session.createSessionEntry(createParams);
}
