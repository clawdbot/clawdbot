import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveSessionAgentIdsStrict } from "../agent-scope.js";
import { AgentHarnessPreflightError } from "./errors.js";
import { getRegisteredAgentHarness } from "./registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "./types.js";

/** Reads private ownership for a caller-supplied authoritative session, never a pin heuristic. */
export function readSessionRuntimeOwnership(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  sessionEntry?: Partial<
    Pick<SessionEntry, "sessionId" | "agentHarnessId" | "modelSelectionLocked" | "pluginOwnerId">
  >;
  assertCurrent?: () => void;
}): AgentHarnessSessionRuntimeOwnership | undefined {
  const entry = params.sessionEntry;
  const sessionId = entry?.sessionId;
  const harnessId = resolveSessionPinnedHarnessId(entry);
  if (!sessionId || !harnessId) {
    return undefined;
  }
  const harness = getRegisteredAgentHarness(harnessId)?.harness;
  if (!harness?.resolveSessionRuntimeOwnership) {
    return undefined;
  }
  const { config, agentId, sessionKey, storePath } = params;
  let active = true;
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (
      !active ||
      getRegisteredAgentHarness(harnessId)?.harness !== harness ||
      entry?.sessionId !== sessionId ||
      resolveSessionPinnedHarnessId(entry) !== harnessId
    ) {
      throw new AgentHarnessPreflightError(
        "Native session ownership changed while reading its runtime. Reattach the original native session before retrying.",
      );
    }
  };
  try {
    assertCurrent();
    const ownership = harness.resolveSessionRuntimeOwnership({
      config,
      agentId,
      sessionId,
      sessionKey,
      storePath,
      // Binding hits need no row read. A miss must observe lineage after any awaited metadata work.
      readPreviousSessionId: () => {
        assertCurrent();
        const key = sessionKey?.trim();
        if (!key) {
          return undefined;
        }
        const { sessionAgentId } = resolveSessionAgentIdsStrict({ config, agentId, sessionKey });
        const current = loadSessionEntryReadOnly({
          agentId: sessionAgentId,
          sessionKey: key,
          storePath:
            storePath?.trim() ||
            resolveSessionStorePathCore(config?.session?.store, { agentId: sessionAgentId }),
          hydrateSkillPromptRefs: false,
          readConsistency: "latest",
        });
        assertCurrent();
        return current?.sessionId === sessionId ? current.previousSessionId : undefined;
      },
      assertCurrent,
    });
    assertCurrent();
    return ownership
      ? { ...ownership, ...(ownership.modelRef ? { modelRef: { ...ownership.modelRef } } : {}) }
      : undefined;
  } finally {
    active = false;
  }
}
