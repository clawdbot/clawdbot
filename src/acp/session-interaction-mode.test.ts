import { describe, expect, it } from "vitest";
import {
  isParentOwnedBackgroundAcpSession,
  isRequesterParentOfBackgroundAcpSession,
} from "./session-interaction-mode.js";

const parentKey = "agent:main:main";
const otherKey = "agent:peer:some-other";

describe("isParentOwnedBackgroundAcpSession", () => {
  it("returns interactive when entry is undefined", () => {
    expect(isParentOwnedBackgroundAcpSession(undefined)).toBe(false);
  });

  it("returns parent-owned-background for persistent sessions with spawnedBy set", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "persistent" } as never,
        spawnedBy: parentKey,
      }),
    ).toBe(true);
  });

  it("returns interactive for persistent ACP sessions without parent linkage", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "persistent" } as never,
      }),
    ).toBe(false);
  });

  it("returns parent-owned-background for oneshot sessions with spawnedBy set", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "oneshot" } as never,
        spawnedBy: parentKey,
      }),
    ).toBe(true);
  });

  it("returns parent-owned-background for oneshot sessions with parentSessionKey set", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "oneshot" } as never,
        parentSessionKey: parentKey,
      }),
    ).toBe(true);
  });

  it("returns interactive for a oneshot session without any parent linkage", () => {
    expect(
      isParentOwnedBackgroundAcpSession({
        acp: { mode: "oneshot" } as never,
      }),
    ).toBe(false);
  });
});

describe("isRequesterParentOfBackgroundAcpSession", () => {
  const backgroundEntry = {
    acp: { mode: "oneshot" } as never,
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
  };

  it("returns true when requester matches spawnedBy", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "oneshot" } as never, spawnedBy: parentKey },
        parentKey,
      ),
    ).toBe(true);
  });

  it("returns true when requester matches parentSessionKey", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "oneshot" } as never, parentSessionKey: parentKey },
        parentKey,
      ),
    ).toBe(true);
  });

  it("returns false when requester is a different session (not the parent)", () => {
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, otherKey)).toBe(false);
  });

  it("returns false when requester key is missing", () => {
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, undefined)).toBe(false);
    expect(isRequesterParentOfBackgroundAcpSession(backgroundEntry, "")).toBe(false);
  });

  it("returns true when target is parent-owned persistent ACP session", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "persistent" } as never, spawnedBy: parentKey },
        parentKey,
      ),
    ).toBe(true);
  });

  it("delegates to isParentOwnedBackgroundAcpSession for target-only checks", () => {
    expect(isParentOwnedBackgroundAcpSession(backgroundEntry)).toBe(true);
  });
});
