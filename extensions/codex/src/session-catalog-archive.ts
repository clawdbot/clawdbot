import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { sessionCatalogAdoptedSourceKey } from "openclaw/plugin-sdk/session-catalog";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import { assertCodexArchiveDescendantsUnowned } from "./app-server/thread-archive-guard.js";
import { isAdoptionSessionKeyForThread, requireIdleThread } from "./session-catalog-adoption.js";
import { runSessionActionExclusive } from "./session-catalog-node-adoption.js";
import { CatalogParamsError, CODEX_LOCAL_SESSION_HOST_ID } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

function assertNoPendingSupervisionBranch(params: {
  agentId: string;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  threadId: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
}): void {
  const adoptedEntries = [
    params.agentId,
    ...listAgentIds(params.config).filter((agentId) => agentId !== params.agentId),
  ]
    .flatMap((agentId) =>
      params.runtime.agent.session.listSessionEntries({ agentId, readOnly: true }),
    )
    .filter(
      (candidate) =>
        isAdoptionSessionKeyForThread(candidate.sessionKey, params.threadId, params.sourceHomeId) ||
        (params.sourceHomeId !== undefined &&
          params.allowLegacy === true &&
          isAdoptionSessionKeyForThread(candidate.sessionKey, params.threadId)),
    );
  for (const adopted of adoptedEntries) {
    if (adopted.entry.initializationPending === true) {
      throw new CatalogParamsError(
        "Codex session cannot be archived while its OpenClaw branch is initializing",
      );
    }
    const sessionId = adopted.entry.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const binding = params.bindingStore.read(
      sessionBindingIdentity({
        sessionId,
        sessionKey: adopted.sessionKey,
        config: params.config,
      }),
    );
    if (
      binding?.connectionScope === "supervision" &&
      binding.supervisionSourceThreadId === params.threadId &&
      binding.pendingSupervisionBranch?.sourceThreadId === params.threadId
    ) {
      throw new CatalogParamsError(
        "Codex session cannot be archived until its OpenClaw branch starts",
      );
    }
  }
}

/** Archives one inactive Gateway-local Codex thread after a fresh status read. */
export async function archiveLocalCodexSession(params: {
  agentId: string;
  bindingStore: CodexAppServerBindingStore;
  config: OpenClawConfig;
  control: CodexSessionCatalogControl;
  runtime: PluginRuntime;
  threadId: string;
  hostId?: string;
  sourceHomeId?: string;
  allowLegacy?: boolean;
}): Promise<{ archived: true }> {
  return await runSessionActionExclusive(
    sessionCatalogAdoptedSourceKey(params.hostId ?? CODEX_LOCAL_SESSION_HOST_ID, params.threadId),
    async () => {
      return await params.bindingStore.withThreadArchiveFence(async () => {
        const run = async (control: CodexSessionCatalogControl) => {
          assertNoPendingSupervisionBranch(params);
          await control.requireEligibleThread(params.threadId);
          // Eligibility reads metadata before checking membership; activity can change meanwhile.
          const thread = await control.readThread(params.threadId, false);
          if (thread.id !== params.threadId) {
            throw new Error("Codex app-server returned a different thread than requested");
          }
          requireIdleThread(thread, "archive");
          if (await params.bindingStore.hasOtherThreadOwner(params.threadId)) {
            throw new CatalogParamsError(
              "Codex session cannot be archived while it is attached to an OpenClaw session",
            );
          }
          await assertCodexArchiveDescendantsUnowned({
            bindingStore: params.bindingStore,
            threadId: params.threadId,
            listPage: (request) => control.listDescendantPage(request),
            assertDescendantIdle: async (descendantThreadId) => {
              const descendant = await control.readThread(descendantThreadId, false);
              if (descendant.id !== descendantThreadId) {
                throw new Error("Codex app-server returned a different descendant than requested");
              }
              requireIdleThread(descendant, "archive");
            },
          });
          await control.archiveThread(params.threadId);
          return { archived: true as const };
        };
        return await params.control.withPinnedConnection(run);
      });
    },
  );
}
