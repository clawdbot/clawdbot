/** Regression: /acp close must clear the acpx FileSessionStore resume pointer
 * even when the backend close is unavailable, so the next inbound message
 * starts a fresh session (session/new) instead of resuming the closed one
 * (session/resume). See openclaw/openclaw #107487.
 *
 * handleAcpCloseAction closes with { allowBackendUnavailable: true, clearMeta: true }
 * but no discardPersistentState. When the backend close is unavailable, the
 * recovery path must still run the acpx fresh-reset primitive (prepareFreshSession,
 * which in production calls sessionStore.markFresh) so readReusablePersistentSessionCommand
 * returns fresh on the next message instead of the stale closed-session id. */
import { describe, expect, it } from "vitest";
import { withAcpManagerTaskStateDir } from "../../../test/helpers/acp-manager-task-state.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockParentedAcpSessionEntries,
} from "./manager.test-helpers.js";

describe("AcpSessionManager closeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("clears the acpx resume pointer on close even when the backend close is unavailable", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:child-1";
      const runtimeState = createRuntime();
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "acpx",
        runtime: runtimeState.runtime,
      });
      mockParentedAcpSessionEntries({
        childSessionKey: sessionKey,
        parentSessionKey: "agent:main:main",
      });
      // The backend close is unavailable; the recovery path must still clear the
      // acpx FileSessionStore resume pointer via prepareFreshSession.
      runtimeState.close.mockImplementation(async () => {
        throw new AcpRuntimeError(
          "ACP_BACKEND_UNAVAILABLE",
          "backend unavailable on close",
        );
      });

      const manager = new AcpSessionManager();
      const result = await manager.closeSession({
        cfg: baseCfg,
        sessionKey,
        agentId: "codex",
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      });

      // prepareFreshSession is the fresh-reset primitive that, in production,
      // calls sessionStore.markFresh so the closed session is not resumed on the
      // next message (readReusablePersistentSessionCommand returns fresh).
      expect(runtimeState.prepareFreshSession).toHaveBeenCalledTimes(1);
      expect(runtimeState.prepareFreshSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, agentId: "codex" }),
      );
      // The explicit close still completes gracefully and clears session meta
      // instead of propagating the unavailable-backend error.
      expect(result.metaCleared).toBe(true);
    });
  });
});
