import { describe, expect, it } from "vitest";
import { resolveAttemptDispatchApiKey } from "./auth-store.js";

const apiKeyInfo = {
  apiKey: "source-token",
  source: "profile:test",
  mode: "oauth" as const,
};

const runtimeAuthState = {
  generation: 1,
  sourceApiKey: "source-token",
  authMode: "oauth",
  profileId: "test:profile",
};

describe("resolveAttemptDispatchApiKey", () => {
  it("keeps provider-prepared runtime auth inside the core transport", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState,
        pluginHarnessOwnsTransport: false,
      }),
    ).toBeUndefined();
  });

  it("forwards the resolved source credential to a transport-owning harness", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState,
        pluginHarnessOwnsTransport: true,
      }),
    ).toBe("source-token");
  });

  it("keeps direct credentials available without provider runtime auth", () => {
    expect(
      resolveAttemptDispatchApiKey({
        apiKeyInfo,
        runtimeAuthState: null,
        pluginHarnessOwnsTransport: false,
      }),
    ).toBe("source-token");
  });
});
