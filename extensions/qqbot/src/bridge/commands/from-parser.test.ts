import { describe, expect, it } from "vitest";
import { parseQQBotFrom } from "./from-parser.js";

describe("parseQQBotFrom", () => {
  it("parses a group from string", () => {
    expect(parseQQBotFrom("qqbot:group:ABCDEF")).toEqual({
      msgType: "group",
      targetType: "group",
      targetId: "ABCDEF",
    });
  });

  it("parses a channel prefix into the guild msgType", () => {
    expect(parseQQBotFrom("qqbot:channel:123")).toEqual({
      msgType: "guild",
      targetType: "channel",
      targetId: "123",
    });
  });

  it("parses a dm prefix", () => {
    expect(parseQQBotFrom("qqbot:dm:456")).toEqual({
      msgType: "dm",
      targetType: "dm",
      targetId: "456",
    });
  });

  it("parses a c2c prefix", () => {
    expect(parseQQBotFrom("qqbot:c2c:user-1")).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "user-1",
    });
  });

  it("is case-insensitive on the qqbot: prefix", () => {
    expect(parseQQBotFrom("QQBOT:group:gid")).toEqual({
      msgType: "group",
      targetType: "group",
      targetId: "gid",
    });
  });

  it("handles target ids that contain a colon", () => {
    expect(parseQQBotFrom("qqbot:group:GROUP:ID")).toEqual({
      msgType: "group",
      targetType: "group",
      targetId: "GROUP:ID",
    });
  });

  it("falls back to c2c for unknown prefixes", () => {
    expect(parseQQBotFrom("qqbot:unknown:abc")).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "abc",
    });
  });

  it("falls back to c2c for missing from", () => {
    expect(parseQQBotFrom(undefined)).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "",
    });
    expect(parseQQBotFrom(null)).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "",
    });
    expect(parseQQBotFrom("")).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "",
    });
  });

  it("treats a bare prefix (no colon) as c2c with that id", () => {
    expect(parseQQBotFrom("qqbot:c2c")).toEqual({
      msgType: "c2c",
      targetType: "c2c",
      targetId: "c2c",
    });
  });
});
