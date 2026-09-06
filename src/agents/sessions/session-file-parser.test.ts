import { describe, expect, it } from "vitest";
import { isSessionFileEntry } from "./session-file-parser.js";

describe("isSessionFileEntry", () => {
  it.each([
    ["an arbitrary non-message entry", { type: "plugin_metadata" }],
    ["a message with a current role", { type: "message", message: { role: "user" } }],
    ["a message with a future role", { type: "message", message: { role: "future_role" } }],
  ])("accepts %s", (_label, value) => {
    expect(isSessionFileEntry(value)).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a non-record value", "message"],
    ["a missing type", {}],
    ["a non-string type", { type: 1 }],
    ["a message without message data", { type: "message" }],
    ["a message with null data", { type: "message", message: null }],
    ["a message with array data", { type: "message", message: [] }],
    ["a message without a role", { type: "message", message: {} }],
    ["a message with a non-string role", { type: "message", message: { role: 1 } }],
  ])("rejects %s", (_label, value) => {
    expect(isSessionFileEntry(value)).toBe(false);
  });
});
