import { describe, expect, it } from "vitest";
import { sanitizeToolCallId } from "./pi-embedded-helpers.js";

describe("sanitizeToolCallId", () => {
  describe("standard mode (default)", () => {
    it("keeps valid alphanumeric tool call IDs", () => {
      expect(sanitizeToolCallId("callabc123")).toBe("callabc123");
    });
    it("keeps underscores and hyphens for readability", () => {
      expect(sanitizeToolCallId("call_abc-123")).toBe("call_abc-123");
      expect(sanitizeToolCallId("call_abc_def")).toBe("call_abc_def");
    });
    it("replaces invalid characters with underscores", () => {
      expect(sanitizeToolCallId("call_abc|item:456")).toBe("call_abc_item_456");
    });
    it("returns default for empty IDs", () => {
      expect(sanitizeToolCallId("")).toBe("default_tool_id");
    });
  });

  describe("strict mode (alphanumeric only)", () => {
    it("strips all non-alphanumeric characters", () => {
      expect(sanitizeToolCallId("call_abc-123", "strict")).toBe("callabc123");
      expect(sanitizeToolCallId("call_abc|item:456", "strict")).toBe("callabcitem456");
      expect(sanitizeToolCallId("whatsapp_login_1768799841527_1", "strict")).toBe(
        "whatsapplogin17687998415271",
      );
    });
    it("returns default for empty IDs", () => {
      expect(sanitizeToolCallId("", "strict")).toBe("defaulttoolid");
    });
  });

  describe("strict9 mode (Mistral tool call IDs)", () => {
    it("returns alphanumeric IDs with length 9", () => {
      const out = sanitizeToolCallId("call_abc|item:456", "strict9");
      expect(out).toMatch(/^[a-zA-Z0-9]{9}$/);
    });
    it("returns default for empty IDs", () => {
      expect(sanitizeToolCallId("", "strict9")).toMatch(/^[a-zA-Z0-9]{9}$/);
    });
  });
});
