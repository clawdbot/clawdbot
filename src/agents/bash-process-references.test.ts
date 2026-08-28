import { afterEach, describe, expect, it } from "vitest";
import { listActiveProcessSessionReferences } from "./bash-process-references.js";
import { addSession, deleteSession } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("bash-process-references", () => {
  function registerScopedSession(id: string, startedAt = 1_000) {
    const session = createProcessSessionFixture({ id, startedAt, backgrounded: true });
    session.scopeKey = "scope-a";
    addSession(session);
  }

  it("keeps scoped session labels valid when the limit bisects an emoji", () => {
    const command = `${"a".repeat(136)}😀xyz`;
    const session = createProcessSessionFixture({
      id: "emoji-proc-scoped",
      command,
      backgrounded: true,
      startedAt: 1,
      pid: 4242,
    });
    session.scopeKey = "scope-a";
    addSession(session);

    const [reference] = listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2 });
    expect(reference?.name).toBe(`${"a".repeat(136)}...`);
    expect(reference?.pid).toBe(4242);
  });

  it("keeps the newest eight registrations when their start timestamps match", () => {
    for (let index = 1; index <= 9; index += 1) {
      registerScopedSession(`session-${index}`);
    }

    expect(
      listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2_000 }).map(
        ({ sessionId }) => sessionId,
      ),
    ).toEqual(Array.from({ length: 8 }, (_, index) => `session-${9 - index}`));
  });

  it("preserves timestamp precedence when registration order differs", () => {
    for (const [id, startedAt] of [
      ["later-clock", 2_000],
      ["earlier-clock", 1_000],
    ] as const) {
      registerScopedSession(id, startedAt);
    }

    expect(
      listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 3_000 }).map(
        ({ sessionId }) => sessionId,
      ),
    ).toEqual(["later-clock", "earlier-clock"]);
  });

  it("keeps registration chronology unambiguous after removal and id reuse", () => {
    registerScopedSession("removed-first");
    registerScopedSession("retained-second");
    deleteSession("removed-first");
    registerScopedSession("removed-first");

    expect(
      listActiveProcessSessionReferences({ scopeKey: "scope-a", now: 2_000 }).map(
        ({ sessionId }) => sessionId,
      ),
    ).toEqual(["removed-first", "retained-second"]);
  });
});
