import { afterEach, describe, expect, it } from "vitest";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import "./ai-transport-host.js";

afterEach(resetSecretRedactionRegistryForTest);

describe("OpenClaw provider error redaction", () => {
  it("redacts registered opaque secrets from ordinary provider error messages", () => {
    const secret = "opaque-configured-provider-value";
    registerSecretValueForRedaction(secret);

    const projected = projectProviderError({
      message: `provider rejected configured value ${secret}`,
    });

    expect(projected.errorMessage).toContain("provider rejected configured value");
    expect(projected.errorMessage).not.toContain(secret);
  });
});
