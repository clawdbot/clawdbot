import { afterEach, describe, expect, it } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { mintNodeWorkspaceTransferToken } from "./node-workspace-transfer-token.js";

afterEach(resetSecretRedactionRegistryForTest);

describe("node workspace transfer token", () => {
  it("mints one high-entropy process-local bearer and registers it for redaction", () => {
    const token = mintNodeWorkspaceTransferToken(() => "a".repeat(43));

    expect(token).toBe("a".repeat(43));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(isSecretValueRegisteredForRedaction(token)).toBe(true);
  });

  it("rejects malformed generator output", () => {
    expect(() => mintNodeWorkspaceTransferToken(() => "too-short")).toThrow("invalid bearer");
  });
});
