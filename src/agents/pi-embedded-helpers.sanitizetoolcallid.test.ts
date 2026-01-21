import { describe, expect, it } from "vitest";
import { sanitizeToolCallId } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const _makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("sanitizeToolCallId", () => {
  it("keeps valid alphanumeric tool call IDs", () => {
    expect(sanitizeToolCallId("callabc123")).toBe("callabc123");
  });
  it("strips non-alphanumeric characters (Mistral/OpenRouter compatibility)", () => {
    expect(sanitizeToolCallId("call_abc-123")).toBe("callabc123");
    expect(sanitizeToolCallId("call_abc|item:456")).toBe("callabcitem456");
    expect(sanitizeToolCallId("whatsapp_login_1768799841527_1")).toBe("whatsapplogin17687998415271");
  });
  it("returns default for empty IDs", () => {
    expect(sanitizeToolCallId("")).toBe("defaulttoolid");
  });
});
