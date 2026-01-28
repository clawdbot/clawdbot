import { describe, expect, it } from "vitest";

import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "moltbot", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "moltbot", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "moltbot", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "moltbot", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "moltbot", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "moltbot", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "moltbot", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "moltbot"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "moltbot", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "moltbot", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "moltbot", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "moltbot", "status", "--timeout=2500"], "--timeout")).toBe("2500");
    expect(getFlagValue(["node", "moltbot", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "moltbot", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "moltbot", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "moltbot", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "moltbot", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "moltbot", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "moltbot", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "moltbot", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "moltbot", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "moltbot", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node", "moltbot", "status"],
    });
    expect(nodeArgv).toEqual(["node", "moltbot", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node-22", "moltbot", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "moltbot", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node-22.2.0.exe", "moltbot", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "moltbot", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node-22.2", "moltbot", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "moltbot", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node-22.2.exe", "moltbot", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "moltbot", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["/usr/bin/node-22.2.0", "moltbot", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "moltbot", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["nodejs", "moltbot", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "moltbot", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["node-dev", "moltbot", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "moltbot", "node-dev", "moltbot", "status"]);

    const directArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["moltbot", "status"],
    });
    expect(directArgv).toEqual(["node", "moltbot", "status"]);

    const bunArgv = buildParseArgv({
      programName: "moltbot",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "moltbot",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "moltbot", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "moltbot", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "moltbot", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "moltbot", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "moltbot", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "moltbot", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "moltbot", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "moltbot", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
