// Amazon Bedrock tests cover embedding provider plugin behavior.
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockEmbeddingProvider, hasAwsCredentials } from "./embedding-provider.js";
import { embeddingTesting as testing } from "./test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("bedrock embedding region resolution", () => {
  it.each([
    {
      name: "secondary region when the primary env override is blank",
      primary: "   ",
      secondary: "eu-west-1",
      expected: "eu-west-1",
    },
    {
      name: "plugin default when both env overrides are blank",
      primary: "",
      secondary: "   ",
      expected: "us-east-1",
    },
    {
      name: "primary region when both env overrides are nonblank",
      primary: "ap-southeast-2",
      secondary: "eu-west-1",
      expected: "ap-southeast-2",
    },
  ])("uses $name", async ({ primary, secondary, expected }) => {
    vi.stubEnv("AWS_REGION", primary);
    vi.stubEnv("AWS_DEFAULT_REGION", secondary);

    const { client } = await createBedrockEmbeddingProvider({
      config: {},
      model: "",
    });

    expect(client.region).toBe(expected);
  });
});

describe("bedrock embedding endpoint routing", () => {
  it.each([
    {
      name: "memory PrivateLink endpoint ahead of the provider endpoint",
      remoteBaseUrl: "https://vpce-memory.bedrock-runtime.eu-west-1.vpce.amazonaws.com",
      providerBaseUrl: "https://vpce-provider.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      hostname: "vpce-memory.bedrock-runtime.eu-west-1.vpce.amazonaws.com",
      signingRegion: "eu-west-1",
      sdkEndpoint: "https://vpce-environment.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    },
    {
      name: "provider PrivateLink endpoint when memory has no override",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://vpce-provider.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      hostname: "vpce-provider.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      signingRegion: "us-east-1",
    },
    {
      name: "SDK regional endpoint when no override is configured",
      remoteBaseUrl: undefined,
      providerBaseUrl: undefined,
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      signingRegion: "us-east-1",
    },
    {
      name: "SDK FIPS endpoint for a canonical regional provider URL",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-east-1.amazonaws.com",
      signingRegion: "us-east-1",
      fips: true,
      customEndpoint: false,
    },
    {
      name: "SDK dual-stack endpoint for a canonical regional provider URL",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      hostname: "bedrock-runtime.us-east-1.api.aws",
      signingRegion: "us-east-1",
      dualstack: true,
      customEndpoint: false,
    },
    {
      name: "SDK PrivateLink override for a canonical regional provider URL",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      hostname: "vpce-environment.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      signingRegion: "us-east-1",
      sdkEndpoint: "https://vpce-environment.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      customEndpoint: false,
    },
    {
      name: "explicit PrivateLink endpoint that correctly rejects FIPS mode",
      remoteBaseUrl: "https://vpce-memory.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      providerBaseUrl: undefined,
      hostname: "vpce-memory.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      signingRegion: "us-east-1",
      fips: true,
      expectedError: "Invalid Configuration: FIPS and custom endpoint are not supported",
    },
  ])("sends signed requests to the $name", async (testCase) => {
    const { remoteBaseUrl, providerBaseUrl, hostname, signingRegion } = testCase;
    const sdkEndpoint = "sdkEndpoint" in testCase ? testCase.sdkEndpoint : undefined;
    const fips = "fips" in testCase && testCase.fips;
    const dualstack = "dualstack" in testCase && testCase.dualstack;
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_DEFAULT_REGION", undefined);
    vi.stubEnv("AWS_PROFILE", undefined);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "BEDROCK_QA_FIXTURE_ACCESS");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "bedrock-qa-fixture-secret");
    vi.stubEnv("AWS_SESSION_TOKEN", undefined);
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", sdkEndpoint);
    vi.stubEnv("AWS_USE_FIPS_ENDPOINT", fips ? "true" : undefined);
    vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", dualstack ? "true" : undefined);

    const observedRequests: Array<{ hostname: string; authorization: string | undefined }> = [];
    const originalSend = BedrockRuntimeClient.prototype.send;
    vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(
      function (command, options) {
        this.config.requestHandler = {
          handle: async (request) => {
            observedRequests.push({
              hostname: request.hostname,
              authorization: request.headers.authorization,
            });
            return {
              response: {
                statusCode: 200,
                headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify({ embedding: [3, 4] })),
              },
            };
          },
          destroy() {},
        };
        return originalSend.call(this, command, options);
      },
    );

    const { provider, client } = await createBedrockEmbeddingProvider({
      config: providerBaseUrl
        ? {
            models: {
              providers: {
                "amazon-bedrock": { baseUrl: providerBaseUrl, models: [] },
              },
            },
          }
        : {},
      ...(remoteBaseUrl ? { remote: { baseUrl: remoteBaseUrl } } : {}),
      model: "amazon.titan-embed-text-v2:0",
    });

    if ("expectedError" in testCase) {
      await expect(provider.embedQuery("private memory")).rejects.toThrow(testCase.expectedError);
      expect(observedRequests).toEqual([]);
      return;
    }

    await expect(provider.embedQuery("private memory")).resolves.toEqual([0.6, 0.8]);
    expect(observedRequests).toEqual([
      {
        hostname,
        authorization: expect.stringMatching(
          /^AWS4-HMAC-SHA256 Credential=BEDROCK_QA_FIXTURE_ACCESS\//,
        ),
      },
    ]);
    expect(observedRequests[0]?.authorization).toContain(`/${signingRegion}/bedrock/aws4_request`);
    expect(client.region).toBe(signingRegion);
    if ("customEndpoint" in testCase ? testCase.customEndpoint : remoteBaseUrl || providerBaseUrl) {
      expect(client).toHaveProperty("endpoint", remoteBaseUrl ?? providerBaseUrl);
    } else {
      expect(client).not.toHaveProperty("endpoint");
    }
  });
});

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
    const loadCredentialProvider = vi
      .fn()
      .mockResolvedValue(() => async () => ({ accessKeyId: "resolved-access-key" }));

    await expect(hasAwsCredentials({ AWS_PROFILE: "work" }, loadCredentialProvider)).resolves.toBe(
      true,
    );

    expect(loadCredentialProvider).toHaveBeenCalledOnce();
  });

  it("rejects AWS profile markers when the credential chain cannot resolve", async () => {
    const loadCredentialProvider = vi.fn().mockResolvedValue(() => async () => {
      throw new Error("Could not load credentials from any providers");
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

describe("bedrock embedding response parsers", () => {
  it("wraps malformed single embedding JSON", () => {
    expect(() => testing.parseSingle("titan-v2", "{not json")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("wraps malformed batch embedding JSON", () => {
    expect(() => testing.parseCohereBatch("cohere-v3", "{not json")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects non-object embedding JSON", () => {
    expect(() => testing.parseSingle("titan-v2", "[]")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects missing single embedding vectors", () => {
    expect(() => testing.parseSingle("titan-v2", "{}")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects wrong single embedding vector element types", () => {
    expect(() => testing.parseSingle("titan-v2", '{"embedding":[1,"bad"]}')).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects missing batch embedding vectors", () => {
    expect(() => testing.parseCohereBatch("cohere-v3", "{}")).toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });

  it("rejects wrong batch embedding vector shapes", () => {
    expect(() =>
      testing.parseCohereBatch("cohere-v3", '{"embeddings":[[1],{"bad":true}]}'),
    ).toThrow("Amazon Bedrock embedding response returned malformed JSON");
  });
});

describe("stripInferenceProfilePrefix", () => {
  it("strips global prefix", () => {
    expect(testing.stripInferenceProfilePrefix("global.cohere.embed-v4:0")).toBe(
      "cohere.embed-v4:0",
    );
  });

  it("strips us prefix", () => {
    expect(testing.stripInferenceProfilePrefix("us.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips eu prefix", () => {
    expect(testing.stripInferenceProfilePrefix("eu.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips ap prefix", () => {
    expect(testing.stripInferenceProfilePrefix("ap.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips apac prefix", () => {
    expect(testing.stripInferenceProfilePrefix("apac.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips au prefix", () => {
    expect(testing.stripInferenceProfilePrefix("au.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("strips jp prefix", () => {
    expect(testing.stripInferenceProfilePrefix("jp.cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("returns unchanged model ID without prefix", () => {
    expect(testing.stripInferenceProfilePrefix("cohere.embed-v4:0")).toBe("cohere.embed-v4:0");
  });

  it("returns unchanged model ID for amazon.titan-embed-text-v2:0", () => {
    expect(testing.stripInferenceProfilePrefix("amazon.titan-embed-text-v2:0")).toBe(
      "amazon.titan-embed-text-v2:0",
    );
  });
});
