import { describe, expect, it } from "vitest";
import { validateSessionsPatchManyParams, validateSessionsPatchParams } from "../index.js";

describe("session patch schema", () => {
  it("validates lifecycle and unread intent identities", () => {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:self-archive",
        archived: true,
        expectedSessionId: "session-self-archive",
        expectedLifecycleRevision: "revision-self-archive",
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:mark-read",
        unread: false,
        readIntent: "explicit",
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchParams({ key: "agent:main:self-archive", expectedSessionId: "" }),
    ).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:self-archive",
        expectedLifecycleRevision: "",
      }),
    ).toBe(false);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:mark-read",
        unread: false,
        readIntent: "automatic",
      }),
    ).toBe(false);
  });

  it("accepts explicit read intent on bulk targets", () => {
    expect(
      validateSessionsPatchManyParams({
        targets: [{ key: "agent:main:mark-read", readIntent: "explicit" }],
        patch: { unread: false },
      }),
    ).toBe(true);
    expect(
      validateSessionsPatchManyParams({
        targets: [{ key: "agent:main:mark-read", readIntent: "automatic" }],
        patch: { unread: false },
      }),
    ).toBe(false);
  });
});
