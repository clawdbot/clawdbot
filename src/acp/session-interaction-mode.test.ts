import { describe, expect, it } from "vitest";
import {
  isParentOwnedBackgroundAcpSession,
  isRequesterParentOfBackgroundAcpSession,
  resolveAcpSessionInteractionMode,
} from "./session-interaction-mode.js";

const parentKey = "agent:main:main";
const otherKey = "agent:peer:some-other";

describe("resolveAcpSessionInteractionMode", () => {
  it("returns interactive when entry is undefined", () => {
    expect(resolveAcpSessionInteractionMode(undefined)).toBe("interactive");
  });

  it("returns interactive for non-oneshot ACP sessions", () => {
    expect(
      resolveAcpSessionInteractionMode({
        acp: { mode: "persistent" } as never,
        spawnedBy: parentKey,
      }),
    ).toBe("interactive");
  });

  it("returns parent-owned-background for oneshot sessions with spawnedBy set", () => {
    expect(
      resolveAcpSessionInteractionMode({
        acp: { mode: "oneshot" } as never,
        spawnedBy: parentKey,
      }),
    ).toBe("parent-owned-background");
  });

  it("returns parent-owned-background for oneshot sessions with parentSessionKey set", () => {
    expect(
      resolveAcpSessionInteractionMode({
        acp: { mode: "oneshot" } as never,
        parentSessionKey: parentKey,
      }),
    ).toBe("parent-owned-background");
  });

  it("returns interactive for a oneshot session without any parent linkage", () => {
    expect(
      resolveAcpSessionInteractionMode({
        acp: { mode: "oneshot" } as never,
      }),
    ).toBe("interactive");
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

  it("returns false when target is not a parent-owned background ACP session", () => {
    expect(
      isRequesterParentOfBackgroundAcpSession(
        { acp: { mode: "persistent" } as never, spawnedBy: parentKey },
        parentKey,
      ),
    ).toBe(false);
  });

  it("delegates to isParentOwnedBackgroundAcpSession for target-only checks", () => {
    expect(isParentOwnedBackgroundAcpSession(backgroundEntry)).toBe(true);
  });
});
