import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { testing } from "./runs.test-support.js";

describe("embedded-agent runner persistence", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
  });

  it("clears lifecycle ownership when a forced run clear persists killed state", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-force-clear-" },
      async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const sessionKey = "agent:main:main";
        const entry: InternalSessionEntry = {
          lifecycleRunId: "stuck-run",
          sessionId: "session-stuck",
          startedAt: 10,
          status: "running",
          updatedAt: 20,
        };
        await replaceSessionEntry({ storePath, sessionKey }, entry);
        await testing.persistForceClearedEmbeddedRunTerminalState({
          sessionId: entry.sessionId,
          sessionKey,
          startedAt: entry.startedAt,
          storePath,
          updatedAt: entry.updatedAt,
        });

        const persisted = loadSessionEntry({ storePath, sessionKey }) as InternalSessionEntry;
        expect(persisted.status).toBe("killed");
        expect(persisted.lifecycleRunId).toBeUndefined();
      },
    );
  });
});
