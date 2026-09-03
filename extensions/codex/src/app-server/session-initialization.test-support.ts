import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import { continueLocalCodexSession } from "../session-catalog-adoption.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";
import {
  codexForkTurn,
  forkControl,
  forkParams,
  forkResponse,
} from "./upstream-session-fork.test-support.js";

/** Plugin-owned half of the real host creation/deletion integration fixture. */
export async function createCodexSessionInitializationFixture(params: {
  runtime: PluginRuntime;
  workspaceDir: string;
}) {
  const { runtime, workspaceDir } = params;
  const fork = forkParams();
  fork.source.storePath = runtime.agent.session.resolveStorePath(undefined, { agentId: "main" });
  const sourceThread = {
    ...forkResponse("thread-source").thread,
    source: "cli" as const,
    cwd: workspaceDir,
    turns: [codexForkTurn("turn-1", "one"), codexForkTurn("turn-2", "edit me")],
  };
  await runtime.agent.session.upsertSessionEntry({
    ...fork.source,
    entry: { sessionId: fork.source.sessionId, updatedAt: Date.now() },
  });
  await importCodexThreadHistoryToTranscript({
    ...fork.source,
    thread: sourceThread,
    throughTurnId: "turn-2",
  });
  const messages = await readVisibleSessionTranscriptMessageEntries(fork.source);
  fork.source.entryId = expectDefined(messages.at(-1), "source user message").entryId;
  const forkedThread = {
    ...forkResponse().thread,
    cwd: workspaceDir,
    turns: [expectDefined(sourceThread.turns[0], "retained source turn")],
  };
  const native = forkControl(async () => ({ ...forkResponse(), thread: forkedThread }));
  native.control.readThread = async (id) => (id === sourceThread.id ? sourceThread : forkedThread);
  native.control.listTurnPage = async ({ threadId }) => ({
    data: threadId === sourceThread.id ? sourceThread.turns : forkedThread.turns,
  });
  const bindingStore = createCodexAppServerBindingStore(
    runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>({
      namespace: "initialization-test",
      maxEntries: 20,
    }),
  );
  const sourceIdentity = sessionBindingIdentity(fork.source);
  await bindingStore.mutate(sourceIdentity, {
    kind: "set",
    binding: {
      threadId: sourceThread.id,
      cwd: workspaceDir,
      connectionScope: "supervision",
      supervisionSourceThreadId: sourceThread.id,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: {
        sourceThreadId: sourceThread.id,
        connectionFingerprint: "fingerprint",
        lastTurnId: "turn-2",
      },
    },
  });
  native.control.requireEligibleThread = async (threadId) => {
    if (threadId !== sourceThread.id) {
      throw new Error("Unknown fixture source thread");
    }
    return sourceThread;
  };
  return {
    sourceIdentity,
    params: fork,
    sourceThread,
    forkedThread,
    native,
    bindingStore,
    harness: createCodexAppServerAgentHarness({
      bindingStore,
      runtime,
      sessionCatalogControlFactory: native.controlFactory,
    }),
    adopt: async () => {
      try {
        const result = await continueLocalCodexSession({
          api: { ...createCapturedPluginRegistration({ id: "codex" }).api, runtime },
          agentId: "main",
          bindingStore,
          config: {},
          control: native.control,
          threadId: sourceThread.id,
        });
        return { status: "created", key: result.sessionKey };
      } catch (error) {
        return {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
