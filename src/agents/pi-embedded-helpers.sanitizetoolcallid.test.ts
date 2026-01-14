import { describe, expect, it } from "vitest";
import { sanitizeToolCallId } from "./pi-embedded-helpers.js";
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
describe("sanitizeToolCallId", () => {
  it("keeps valid tool call IDs", () => {
    expect(sanitizeToolCallId("call_abc-123")).toBe("call_abc-123");
  });
  it("replaces invalid characters with underscores", () => {
    expect(sanitizeToolCallId("call_abc|item:456")).toBe("call_abc_item_456");
  });
  it("returns default for empty IDs", () => {
    expect(sanitizeToolCallId("")).toBe("default_tool_id");
  });
});
