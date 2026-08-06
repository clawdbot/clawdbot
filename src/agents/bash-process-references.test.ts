import { describe, expect, it } from "vitest";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { addSession, deleteSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";

describe("bash-process-references truncation", () => {
  it("keeps scoped session labels valid when the limit bisects an emoji", () => {
    const command = `${"a".repeat(136)}😀xyz`;
    const session = createProcessSessionFixture({
      id: "emoji-proc-scoped",
      command,
      backgrounded: true,
      startedAt: 1,
    });
    session.scopeKey = "scope-a";
    addSession(session);

    try {
      const [reference] = listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2 });
      expect(reference?.name).toBe(`${"a".repeat(136)}...`);
    } finally {
      deleteSession("emoji-proc-scoped");
    }
  });
});
