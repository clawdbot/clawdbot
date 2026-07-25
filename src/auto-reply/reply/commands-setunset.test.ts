// Tests set/unset command parsing and config mutation replies.
import { describe, expect, it } from "vitest";
import { parseStandardSetUnsetSlashCommand } from "./commands-setunset-standard.js";
import { parseSlashCommandWithSetUnset } from "./commands-setunset.js";

type ParsedSetUnsetAction =
  | { action: "set"; path: string; value: unknown }
  | { action: "unset"; path: string }
  | { action: "error"; message: string };

function createActionMappers() {
  return {
    onSet: (path: string, value: unknown): ParsedSetUnsetAction => ({ action: "set", path, value }),
    onUnset: (path: string): ParsedSetUnsetAction => ({ action: "unset", path }),
    onError: (message: string): ParsedSetUnsetAction => ({ action: "error", message }),
  };
}

function createSlashParams(params: {
  raw: string;
  onKnownAction?: (action: string) => ParsedSetUnsetAction | undefined;
}) {
  return {
    raw: params.raw,
    slash: "/config",
    invalidMessage: "Invalid /config syntax.",
    usageMessage: "Usage: /config show|set|unset",
    onKnownAction: params.onKnownAction ?? (() => undefined),
    ...createActionMappers(),
  };
}

describe("parseSlashCommandWithSetUnset", () => {
  it("returns null when the input does not match the slash command", () => {
    const result = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({ raw: "/debug show" }),
    );
    expect(result).toBeNull();
  });

  it("prefers set/unset mapping and falls back to known actions", () => {
    const setResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        raw: '/config set a.b={"ok":true}',
      }),
    );
    expect(setResult).toEqual({ action: "set", path: "a.b", value: { ok: true } });

    const unsetResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({ raw: "/config unset a.b" }),
    );
    expect(unsetResult).toEqual({ action: "unset", path: "a.b" });

    const showResult = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        raw: "/config show",
        onKnownAction: (action) =>
          action === "show" ? { action: "unset", path: "dummy" } : undefined,
      }),
    );
    expect(showResult).toEqual({ action: "unset", path: "dummy" });
  });

  it("returns onError for unknown actions", () => {
    const unknownAction = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({
        raw: "/config whoami",
      }),
    );
    expect(unknownAction).toEqual({ action: "error", message: "Usage: /config show|set|unset" });

    const invalidSet = parseSlashCommandWithSetUnset<ParsedSetUnsetAction>(
      createSlashParams({ raw: "/config set" }),
    );
    expect(invalidSet).toEqual({
      action: "error",
      message: "Usage: /config set path=value",
    });
  });
});

describe("parseStandardSetUnsetSlashCommand", () => {
  it("uses default set/unset/error mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      raw: '/config set a.b={"ok":true}',
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
    });
    expect(result).toEqual({ action: "set", path: "a.b", value: { ok: true } });
  });

  it("supports caller-provided mappings", () => {
    const result = parseStandardSetUnsetSlashCommand<ParsedSetUnsetAction>({
      raw: "/config unset a.b",
      slash: "/config",
      invalidMessage: "Invalid /config syntax.",
      usageMessage: "Usage: /config show|set|unset",
      onKnownAction: () => undefined,
      onUnset: (path) => ({ action: "unset", path: `wrapped:${path}` }),
    });
    expect(result).toEqual({ action: "unset", path: "wrapped:a.b" });
  });
});
