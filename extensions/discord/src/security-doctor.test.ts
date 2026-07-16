import { describe, expect, it } from "vitest";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";

describe("discord security doctor helpers", () => {
  it("rejects stable ids and wildcard forms", () => {
    expect(isDiscordMutableAllowEntry("*")).toBe(false);
    expect(isDiscordMutableAllowEntry("123456789")).toBe(false);
    expect(isDiscordMutableAllowEntry("<@123456789>")).toBe(false);
    expect(isDiscordMutableAllowEntry("user:123456789")).toBe(false);
    expect(isDiscordMutableAllowEntry("pk:123456789")).toBe(false);
  });

  it("flags freeform names but not prefixed stable-id namespaces", () => {
    expect(isDiscordMutableAllowEntry("alice")).toBe(true);
    expect(isDiscordMutableAllowEntry("discord:alice")).toBe(false);
    expect(isDiscordMutableAllowEntry("user:alice")).toBe(false);
    expect(isDiscordMutableAllowEntry("pk:alice")).toBe(false);
  });

  it("treats empty prefixed entries as mutable placeholders", () => {
    expect(isDiscordMutableAllowEntry("discord:")).toBe(true);
    expect(isDiscordMutableAllowEntry("user:")).toBe(true);
    expect(isDiscordMutableAllowEntry("pk:")).toBe(true);
  });
});
