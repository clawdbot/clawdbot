// Tests slash command parsing boundaries, defaults, and invalid-action handling.
import { describe, expect, it } from "vitest";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";

describe("parseSlashCommandOrNull", () => {
  const opts = { invalidMessage: "invalid" };

  it("returns null when the input doesn't start with the slash prefix", () => {
    expect(parseSlashCommandOrNull("hello world", "/config", opts)).toBeNull();
  });

  it("parses action + args when the input has a clean word boundary", () => {
    const result = parseSlashCommandOrNull("/config show enabled", "/config", opts);
    expect(result).toEqual({ ok: true, action: "show", args: "enabled" });
  });

  it("returns the default action on an empty body", () => {
    const result = parseSlashCommandOrNull("/config", "/config", {
      ...opts,
      defaultAction: "show",
    });
    expect(result).toEqual({ ok: true, action: "show", args: "" });
  });

  describe("regression: #84572 — prefix match must require a word boundary", () => {
    // Previously, `/config-check <args>` matched the `/config` handler
    // via a naive `startsWith` and surfaced as an invalid action, blocking
    // any skill whose name shared a prefix with a built-in command.
    it("does not match a longer command name with a hyphen tail (`/config-check`)", () => {
      expect(parseSlashCommandOrNull("/config-check arg1 arg2", "/config", opts)).toBeNull();
    });

    it("does not match a longer command name with no whitespace after prefix", () => {
      expect(parseSlashCommandOrNull("/configfoo", "/config", opts)).toBeNull();
    });

    it("does not match when prefix sits in the middle of a longer word", () => {
      // /modelsy should not be captured by /models
      expect(parseSlashCommandOrNull("/modelsy", "/models", opts)).toBeNull();
    });

    it("still matches when the boundary is a colon (`/config:json`)", () => {
      // Some clients allow `cmd:subkey` to pass through to the action parser
      // when there's no whitespace — the boundary character is still a
      // separator and not an alpha continuation.
      const result = parseSlashCommandOrNull("/config:json", "/config", opts);
      expect(result).not.toBeNull();
      expect(result?.ok).toBe(true);
    });

    it("still matches the exact prefix with leading whitespace", () => {
      const result = parseSlashCommandOrNull("  /config show ", "/config", opts);
      expect(result).toEqual({ ok: true, action: "show", args: "" });
    });
  });
});
