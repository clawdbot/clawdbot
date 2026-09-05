import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginRuntimeApplication } from "../plugins/lifecycle.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./embedded-agent-runner/run/internal-params.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";

type Refresh = {
  active: boolean;
  holds: number;
  requested?: PluginRuntimeApplication;
  continuation?: RunEmbeddedAgentParamsWithSessionFile;
};

const refreshScope = resolveGlobalSingleton(
  Symbol.for("openclaw.agentPluginRuntimeRefresh"),
  () => new AsyncLocalStorage<Refresh>(),
);

/** Captured host control survives native callbacks without becoming run authority. */
export function captureAgentPluginRuntimeRefresh() {
  const owner = refreshScope.getStore();
  return {
    request: (runtime: PluginRuntimeApplication): boolean => {
      if (!owner?.active) {
        return false;
      }
      owner.requested = runtime;
      return true;
    },
    isRequested: () => owner?.active === true && owner.requested !== undefined,
    isPending: () => owner?.active === true && owner.requested !== undefined && owner.holds === 0,
    hold: () => {
      if (!owner?.active) {
        return () => {};
      }
      owner.holds += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          owner.holds -= 1;
        }
      };
    },
    assertActive: () => {
      if (owner && !owner.active) {
        throw new Error("Plugin runtime changed. Continue with the refreshed tool catalog.");
      }
    },
    assertCurrent: () => {
      if (owner && (!owner.active || owner.requested)) {
        throw new Error(
          "Plugin runtime changed. Continue with the refreshed tool catalog; do not repeat completed actions.",
        );
      }
    },
  };
}

export function hasAgentPluginRuntimeRefresh(): boolean {
  const owner = refreshScope.getStore();
  return owner?.active === true && owner.requested !== undefined && owner.holds === 0;
}

/** Called only after the attempt has persisted its completed tool results and released its tools. */
export function continueAgentAfterPluginRuntimeRefresh(
  params: RunEmbeddedAgentParamsWithSessionFile,
  committedMessages?: EmbeddedRunAttemptResult["pluginRuntimeRefreshMessages"],
): boolean {
  const owner = refreshScope.getStore();
  if (!owner?.active || !owner.requested || owner.holds > 0) {
    return false;
  }
  owner.continuation = {
    ...params,
    pluginGeneration: undefined,
    pluginRuntimeRefreshMessages: [
      ...(params.pluginRuntimeRefreshMessages ?? []),
      ...(committedMessages ?? []),
    ],
    contextEngineLogicalTurnLease: undefined,
    modelHasVision: undefined,
    modelThinkingCapability: undefined,
    modelFallbackAvailability: undefined,
    suppressNextUserMessagePersistence: true,
    prompt:
      "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools. Verify the requested change; do not repeat completed actions or the original user request.",
  };
  return true;
}

/** One visible run owns refresh requests across all of its prepared runtime generations. */
export function createAgentPluginRuntimeRefresh() {
  let owner: Refresh | undefined;
  return {
    run: <T>(run: () => T): T => {
      owner = { active: true, holds: 0 };
      return refreshScope.run(owner, run);
    },
    takeContinuation: () => {
      if (owner) {
        owner.active = false;
      }
      return owner?.continuation;
    },
    close: () => {
      if (owner) {
        owner.active = false;
      }
    },
  };
}
