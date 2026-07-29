import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resolveInboundSessionEnvelopeContext } from "./session-envelope.js";

describe("resolveInboundSessionEnvelopeContext", () => {
  afterEach(() => closeOpenClawAgentDatabasesForTest());

  it("reads the previous timestamp from SQLite without a sessions.json file", async () => {
    await withTempDir({ prefix: "openclaw-session-envelope-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:telegram:dm:1";
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "session-1", updatedAt: 42 },
      );

      expect(
        resolveInboundSessionEnvelopeContext({
          cfg: { session: { store: storePath } },
          agentId: "main",
          sessionKey,
        }),
      ).toMatchObject({ storePath, previousTimestamp: 42 });
    });
  });
});
