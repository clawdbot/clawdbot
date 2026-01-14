import { describe, expect, it } from "vitest";
import { stripThoughtSignatures } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (
  overrides: Partial<WorkspaceBootstrapFile>,
): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("stripThoughtSignatures", () => {
  it("returns non-array content unchanged", () => {
    expect(stripThoughtSignatures("hello")).toBe("hello");
    expect(stripThoughtSignatures(null)).toBe(null);
    expect(stripThoughtSignatures(undefined)).toBe(undefined);
    expect(stripThoughtSignatures(123)).toBe(123);
  });
  it("removes msg_-prefixed thought_signature from content blocks", () => {
    const input = [
      { type: "text", text: "hello", thought_signature: "msg_abc123" },
      { type: "thinking", thinking: "test", thought_signature: "AQID" },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "hello" });
    expect(result[1]).toEqual({
      type: "thinking",
      thinking: "test",
      thought_signature: "AQID",
    });
    expect("thought_signature" in result[0]).toBe(false);
    expect("thought_signature" in result[1]).toBe(true);
  });
  it("preserves blocks without thought_signature", () => {
    const input = [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toEqual(input);
  });
  it("handles mixed blocks with and without thought_signature", () => {
    const input = [
      { type: "text", text: "hello", thought_signature: "msg_abc" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      { type: "thinking", thinking: "hmm", thought_signature: "msg_xyz" },
    ];
    const result = stripThoughtSignatures(input);

    expect(result).toEqual([
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      { type: "thinking", thinking: "hmm" },
    ]);
  });
  it("handles empty array", () => {
    expect(stripThoughtSignatures([])).toEqual([]);
  });
  it("handles null/undefined blocks in array", () => {
    const input = [null, undefined, { type: "text", text: "hello" }];
    const result = stripThoughtSignatures(input);
    expect(result).toEqual([null, undefined, { type: "text", text: "hello" }]);
  });
});
