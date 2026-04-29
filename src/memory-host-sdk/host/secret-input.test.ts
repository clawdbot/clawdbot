import { describe, expect, it } from "vitest";
import { resolveMemorySecretInputString } from "./secret-input.js";

describe("resolveMemorySecretInputString", () => {
  const googleApiKeyRef = {
    source: "env",
    provider: "default",
    id: "GOOGLE_API_KEY",
  };

  it("uses the daemon env for env-backed SecretRefs", () => {
    expect(
      resolveMemorySecretInputString({
        value: googleApiKeyRef,
        path: "agents.main.memorySearch.remote.apiKey",
        env: { GOOGLE_API_KEY: "resolved-key" },
      }),
    ).toBe("resolved-key");
  });

  it("still throws when an env-backed SecretRef is missing from the daemon env", () => {
    expect(() =>
      resolveMemorySecretInputString({
        value: googleApiKeyRef,
        path: "agents.main.memorySearch.remote.apiKey",
        env: {},
      }),
    ).toThrow(/unresolved SecretRef/);
  });
});
