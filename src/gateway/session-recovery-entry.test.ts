import { describe, expect, it } from "vitest";
import type { InternalSessionEntry } from "../config/sessions.js";
import { buildRestartRecoverySuccessorEntry } from "./session-recovery-entry.js";

describe("buildRestartRecoverySuccessorEntry", () => {
  it("preserves the session stream mode on the recovered generation", () => {
    const source = {
      sessionId: "interrupted-session",
      updatedAt: 1,
      streamingMode: "block",
    } satisfies InternalSessionEntry;

    expect(
      buildRestartRecoverySuccessorEntry({
        sessionId: "recovered-session",
        source,
        creation: { actor: { type: "system", id: "restart-recovery" } },
      }),
    ).toMatchObject({
      sessionId: "recovered-session",
      previousSessionId: "interrupted-session",
      streamingMode: "block",
    });
  });
});
