import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session patches", () => {
  it("rejects a patch whose owner closes during asynchronous preparation", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-patch-owner" }, async () => {
      const runtime = createRuntimeAgent();
      const scope = { agentId: "main", sessionKey: "agent:main:reef:group:room" };
      await runtime.session.upsertSessionEntry({
        ...scope,
        entry: { sessionId: "original", updatedAt: 100, displayName: "Original title" },
      });
      const original = runtime.session.getSessionEntry(scope);
      const preparing = createDeferred();
      const releasePreparation = createDeferred();
      let ownerActive = true;
      const patch = runtime.session.patchSessionEntry({
        ...scope,
        preserveActivity: true,
        assertCommitAllowed: () => {
          if (!ownerActive) {
            throw new Error("Session patch owner closed");
          }
        },
        update: async () => {
          preparing.resolve();
          await releasePreparation.promise;
          return { displayName: "Stale title" };
        },
      });
      try {
        await preparing.promise;
        ownerActive = false;
        releasePreparation.resolve();
        await expect(patch).rejects.toThrow("Session patch owner closed");
        expect(runtime.session.getSessionEntry(scope)).toEqual(original);
      } finally {
        releasePreparation.resolve();
        await patch.catch(() => undefined);
      }
    });
  });
});
