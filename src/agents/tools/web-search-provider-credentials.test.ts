import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { resolveWebSearchProviderCredential } from "./web-search-provider-credentials.js";

describe("resolveWebSearchProviderCredential", () => {
  it("uses configured literal credentials before ambient env fallback", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: "configured-test-value",
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("configured-test-value");
    });
  });

  it("resolves configured env SecretRefs", () => {
    withEnv({ TEST_WEB_SEARCH_REF_KEY: "ref-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: {
            source: "env",
            provider: "default",
            id: "TEST_WEB_SEARCH_REF_KEY",
          },
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("ref-test-value");
    });
  });

  it("does not override missing env SecretRefs with ambient env fallback", () => {
    withEnv(
      { TEST_WEB_SEARCH_REF_KEY: undefined, TEST_WEB_SEARCH_KEY: "ambient-test-value" },
      () => {
        expect(
          resolveWebSearchProviderCredential({
            credentialValue: {
              source: "env",
              provider: "default",
              id: "TEST_WEB_SEARCH_REF_KEY",
            },
            path: "tools.web.search.provider.apiKey",
            envVars: ["TEST_WEB_SEARCH_KEY"],
          }),
        ).toBeUndefined();
      },
    );
  });

  it("does not override non-env SecretRefs with ambient env fallback", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: {
            source: "file",
            provider: "vault",
            id: "/providers/web-search/api-key",
          },
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBeUndefined();
    });
  });

  it("falls back to ambient env when no credential is configured", () => {
    withEnv({ TEST_WEB_SEARCH_KEY: "ambient-test-value" }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: undefined,
          path: "tools.web.search.provider.apiKey",
          envVars: ["TEST_WEB_SEARCH_KEY"],
        }),
      ).toBe("ambient-test-value");
    });
  });
});
