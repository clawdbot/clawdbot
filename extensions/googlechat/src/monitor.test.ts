import { describe, expect, it } from "vitest";

import { isSenderAllowed, resolveSpaceType } from "./monitor.js";

describe("isSenderAllowed", () => {
  it("matches allowlist entries with users/<email>", () => {
    expect(
      isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"]),
    ).toBe(true);
  });

  it("matches allowlist entries with raw email", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(
      true,
    );
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching emails", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["users/other@example.com"])).toBe(
      false,
    );
  });
});

describe("resolveSpaceType", () => {
  describe("modern spaceType field", () => {
    it("detects DIRECT_MESSAGE as DM", () => {
      const result = resolveSpaceType({ spaceType: "DIRECT_MESSAGE" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });

    it("detects SPACE as group", () => {
      const result = resolveSpaceType({ spaceType: "SPACE" });
      expect(result.spaceType).toBe("SPACE");
      expect(result.isGroup).toBe(true);
    });

    it("detects GROUP_CHAT as group", () => {
      const result = resolveSpaceType({ spaceType: "GROUP_CHAT" });
      expect(result.spaceType).toBe("GROUP_CHAT");
      expect(result.isGroup).toBe(true);
    });

    it("handles lowercase spaceType", () => {
      const result = resolveSpaceType({ spaceType: "direct_message" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });
  });

  describe("deprecated type field fallback", () => {
    it("maps legacy DM to DIRECT_MESSAGE", () => {
      const result = resolveSpaceType({ type: "DM" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });

    it("maps legacy ROOM to SPACE", () => {
      const result = resolveSpaceType({ type: "ROOM" });
      expect(result.spaceType).toBe("SPACE");
      expect(result.isGroup).toBe(true);
    });

    it("handles lowercase legacy type", () => {
      const result = resolveSpaceType({ type: "dm" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });
  });

  describe("field priority", () => {
    it("prefers modern spaceType over deprecated type", () => {
      const result = resolveSpaceType({ spaceType: "SPACE", type: "DM" });
      expect(result.spaceType).toBe("SPACE");
      expect(result.isGroup).toBe(true);
    });

    it("falls back to type only when spaceType is missing", () => {
      const result = resolveSpaceType({ type: "DM" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });

    it("falls back to type when spaceType is empty string", () => {
      const result = resolveSpaceType({ spaceType: "", type: "DM" });
      expect(result.spaceType).toBe("DIRECT_MESSAGE");
      expect(result.isGroup).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("treats empty space as group", () => {
      const result = resolveSpaceType({});
      expect(result.spaceType).toBe("");
      expect(result.isGroup).toBe(true);
    });

    it("treats unknown spaceType as group", () => {
      const result = resolveSpaceType({ spaceType: "UNKNOWN_TYPE" });
      expect(result.spaceType).toBe("UNKNOWN_TYPE");
      expect(result.isGroup).toBe(true);
    });
  });
});
