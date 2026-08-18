import { describe, expect, it } from "vitest";
import {
  shouldAuditPlaintextMcpValue,
  shouldIncludeConfigureMcpCandidate,
} from "./mcp-target-sensitivity.js";

describe("MCP secret target sensitivity", () => {
  it.each(["true", "https://example.test", "application/json"])(
    "treats benign literal %s as non-secret even under a sensitive key",
    (value) => {
      expect(shouldAuditPlaintextMcpValue({ name: "API_TOKEN", value })).toBe(false);
    },
  );

  it("flags credential-like names and values", () => {
    expect(shouldAuditPlaintextMcpValue({ name: "API_TOKEN", value: "abc123" })).toBe(true);
    expect(shouldAuditPlaintextMcpValue({ name: "SERVICE_APIKEY", value: 12345 })).toBe(true);
    expect(shouldAuditPlaintextMcpValue({ name: "custom", value: "Bearer abc123" })).toBe(true);
  });

  it("includes canonical refs while treating shorthand strings as literals", () => {
    expect(
      shouldIncludeConfigureMcpCandidate({
        name: "MODE",
        value: { source: "env", provider: "default", id: "MCP_MODE" },
      }),
    ).toBe(true);
    expect(shouldIncludeConfigureMcpCandidate({ name: "MODE", value: "$MCP_MODE" })).toBe(false);
  });
});
