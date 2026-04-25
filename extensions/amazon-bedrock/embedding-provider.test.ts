import { describe, expect, it, vi } from "vitest";
import { hasAwsCredentials } from "./embedding-provider.js";

describe("hasAwsCredentials", () => {
  it("accepts static AWS key credentials without loading the credential chain", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(
      hasAwsCredentials(
        {
          AWS_ACCESS_KEY_ID: "access-key",
          AWS_SECRET_ACCESS_KEY: "secret-key",
        },
        loadCredentialProvider,
      ),
    ).resolves.toBe(true);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("accepts the Bedrock bearer token without loading the credential chain", async () => {
    const loadCredentialProvider = vi.fn();

    await expect(
      hasAwsCredentials(
        {
          AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
        },
        loadCredentialProvider,
      ),
    ).resolves.toBe(true);

    expect(loadCredentialProvider).not.toHaveBeenCalled();
  });

  it("requires AWS profile credentials to resolve through the credential chain", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue({
      defaultProvider: () => async () => ({ accessKeyId: "resolved-access-key" }),
    });

    await expect(hasAwsCredentials({ AWS_PROFILE: "work" }, loadCredentialProvider)).resolves.toBe(
      true,
    );

    expect(loadCredentialProvider).toHaveBeenCalledOnce();
  });

  it("rejects AWS profile markers when the credential chain cannot resolve", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue({
      defaultProvider: () => async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });

    await expect(
      hasAwsCredentials({ AWS_PROFILE: "missing" }, loadCredentialProvider),
    ).resolves.toBe(false);
  });

  it("returns false when the AWS credential provider package is unavailable", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue(null);

    await expect(hasAwsCredentials({}, loadCredentialProvider)).resolves.toBe(false);
  });
});
