// Amazon Bedrock tests cover embedding provider plugin behavior.
import * as bedrockRuntimeSdk from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockEmbeddingProvider, hasAwsCredentials } from "./embedding-provider.js";

vi.mock("@aws-sdk/client-bedrock-runtime", { spy: true });

afterEach(() => {
  vi.mocked(bedrockRuntimeSdk.BedrockRuntimeClient).mockReset();
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
      name: "configured canonical FIPS endpoint in its own signing region",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-west-2.amazonaws.com",
      signingRegion: "us-west-2",
      customEndpoint: false,
    },
    {
      name: "configured canonical FIPS endpoint with SDK FIPS mode",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-west-2.amazonaws.com",
      signingRegion: "us-west-2",
      fips: true,
      customEndpoint: false,
    },
    {
      name: "configured canonical dual-stack endpoint",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-west-2.api.aws",
      hostname: "bedrock-runtime.us-west-2.api.aws",
      signingRegion: "us-west-2",
      customEndpoint: false,
    },
    {
      name: "configured canonical dual-stack endpoint with SDK dual-stack mode",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-west-2.api.aws",
      hostname: "bedrock-runtime.us-west-2.api.aws",
      signingRegion: "us-west-2",
      dualstack: true,
      customEndpoint: false,
    },
    {
      name: "configured canonical combined FIPS and dual-stack endpoint",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-west-2.api.aws",
      hostname: "bedrock-runtime-fips.us-west-2.api.aws",
      signingRegion: "us-west-2",
      customEndpoint: false,
    },
    {
      name: "configured canonical combined FIPS and dual-stack endpoint with SDK modes",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-west-2.api.aws",
      hostname: "bedrock-runtime-fips.us-west-2.api.aws",
      signingRegion: "us-west-2",
      fips: true,
      dualstack: true,
      customEndpoint: false,
    },
    {
      name: "configured FIPS endpoint upgraded by SDK dual-stack mode",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-west-2.api.aws",
      signingRegion: "us-west-2",
      dualstack: true,
      customEndpoint: false,
    },
    {
      name: "configured dual-stack endpoint upgraded by SDK FIPS mode",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-west-2.api.aws",
      hostname: "bedrock-runtime-fips.us-west-2.api.aws",
      signingRegion: "us-west-2",
      fips: true,
      customEndpoint: false,
    },
    {
      name: "configured GovCloud FIPS endpoint with partition-aware signing",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
      hostname: "bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
      signingRegion: "us-gov-west-1",
      customEndpoint: false,
    },
    {
      name: "configured China FIPS dual-stack endpoint with its partition DNS suffix",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime-fips.cn-north-1.api.amazonwebservices.com.cn",
      hostname: "bedrock-runtime-fips.cn-north-1.api.amazonwebservices.com.cn",
      signingRegion: "cn-north-1",
      customEndpoint: false,
    },
    {
      name: "ISO PrivateLink endpoint when speculative security modes are unsupported",
      remoteBaseUrl: "https://vpce-memory.bedrock-runtime.us-iso-east-1.c2s.ic.gov",
      providerBaseUrl: undefined,
      hostname: "vpce-memory.bedrock-runtime.us-iso-east-1.c2s.ic.gov",
      signingRegion: "us-iso-east-1",
      unsupportedPartitionModes: true,
    },
    {
      name: "ISO regional endpoint that correctly rejects an explicitly requested unsupported mode",
      remoteBaseUrl: undefined,
      providerBaseUrl: "https://bedrock-runtime.us-iso-east-1.c2s.ic.gov",
      hostname: "bedrock-runtime.us-iso-east-1.c2s.ic.gov",
      signingRegion: "us-iso-east-1",
      dualstack: true,
      unsupportedPartitionModes: true,
      expectedError: "DualStack is enabled but this partition does not support DualStack",
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
    {
      name: "explicit PrivateLink endpoint that correctly rejects dual-stack mode",
      remoteBaseUrl: "https://vpce-memory.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      providerBaseUrl: undefined,
      hostname: "vpce-memory.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      signingRegion: "us-east-1",
      dualstack: true,
      expectedError: "Invalid Configuration: Dualstack and custom endpoint are not supported",
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

    if ("unsupportedPartitionModes" in testCase) {
      const { BedrockRuntimeClient: ActualBedrockRuntimeClient } = await vi.importActual<
        typeof import("@aws-sdk/client-bedrock-runtime")
      >("@aws-sdk/client-bedrock-runtime");
      vi.mocked(bedrockRuntimeSdk.BedrockRuntimeClient).mockImplementation(
        class extends ActualBedrockRuntimeClient {
          constructor(...args: ConstructorParameters<typeof ActualBedrockRuntimeClient>) {
            super(...args);
            const endpointProvider = this.config.endpointProvider.bind(this.config);
            vi.spyOn(this.config, "endpointProvider").mockImplementation((parameters, context) => {
              if (
                parameters.Region === "us-iso-east-1" &&
                !parameters.Endpoint &&
                (parameters.UseFIPS || parameters.UseDualStack)
              ) {
                const unsupportedMode = parameters.UseFIPS ? "FIPS" : "DualStack";
                throw new Error(
                  `${unsupportedMode} is enabled but this partition does not support ${unsupportedMode}`,
                );
              }
              return endpointProvider(parameters, context);
            });
          }
        },
      );
    }

    const observedRequests: Array<{ hostname: string; authorization: string | undefined }> = [];
    vi.spyOn(NodeHttp2Handler, "create").mockImplementation(() => {
      const requestHandler = new NodeHttp2Handler();
      vi.spyOn(requestHandler, "handle").mockImplementation(async (request) => {
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
      });
      return requestHandler;
    });

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
      await expect(provider.embed("private memory", { inputType: "query" })).rejects.toThrow(
        testCase.expectedError,
      );
      expect(observedRequests).toEqual([]);
      return;
    }

    await expect(provider.embed("private memory", { inputType: "query" })).resolves.toEqual([
      0.6, 0.8,
    ]);
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

describe("bedrock embedding response parsing", () => {
  it.each([
    { name: "malformed single JSON", model: "amazon.titan-embed-text-v2:0", raw: "{not json" },
    { name: "non-object JSON", model: "amazon.titan-embed-text-v2:0", raw: "[]" },
    { name: "missing single vector", model: "amazon.titan-embed-text-v2:0", raw: "{}" },
    {
      name: "invalid single vector element",
      model: "amazon.titan-embed-text-v2:0",
      raw: '{"embedding":[1,"bad"]}',
    },
    { name: "malformed batch JSON", model: "cohere.embed-english-v3", raw: "{not json" },
    { name: "missing batch vectors", model: "cohere.embed-english-v3", raw: "{}" },
    {
      name: "invalid batch vector shape",
      model: "cohere.embed-english-v3",
      raw: '{"embeddings":[[1],{"bad":true}]}',
    },
    ...[
      { model: "amazon.titan-embed-text-v2:0", vector: '"embedding":[3,4]' },
      { model: "cohere.embed-english-v3", vector: '"embeddings":[[3,4]]' },
    ].map(({ model, vector }) => ({
      name: `invalid UTF-8 for ${model}`,
      model,
      raw: Buffer.concat([
        Buffer.from('{"ignored":"bad'),
        Buffer.from([0xff]),
        Buffer.from(`",${vector}}`),
      ]),
    })),
  ])("rejects $name through the provider boundary", async ({ model, raw }) => {
    vi.spyOn(bedrockRuntimeSdk.BedrockRuntimeClient.prototype, "send").mockResolvedValue({
      body: typeof raw === "string" ? new TextEncoder().encode(raw) : raw,
    } as never);
    const { provider } = await createBedrockEmbeddingProvider({ config: {}, model });
    const request = model.startsWith("cohere.")
      ? provider.embedBatch(["private memory"], { inputType: "document" })
      : provider.embed("private memory", { inputType: "query" });

    await expect(request).rejects.toThrow(
      "Amazon Bedrock embedding response returned malformed JSON",
    );
  });
});

describe("bedrock embedding inference profiles", () => {
  it.each(["global", "us", "eu", "ap", "apac", "au", "jp"])(
    "uses the Cohere v4 contract for the %s profile prefix",
    async (prefix) => {
      const model = `${prefix}.cohere.embed-v4:0`;
      const send = vi
        .spyOn(bedrockRuntimeSdk.BedrockRuntimeClient.prototype, "send")
        .mockResolvedValue({
          body: new TextEncoder().encode('{"embeddings":{"float":[[3,4]]}}'),
        } as never);
      const { provider, client } = await createBedrockEmbeddingProvider({ config: {}, model });

      await expect(provider.embed("private memory", { inputType: "query" })).resolves.toEqual([
        0.6, 0.8,
      ]);

      const command = send.mock.calls.at(-1)?.[0] as {
        input?: { body?: string | Uint8Array; modelId?: string };
      };
      const body =
        typeof command.input?.body === "string"
          ? command.input.body
          : new TextDecoder().decode(command.input?.body);
      expect(JSON.parse(body)).toEqual({
        texts: ["private memory"],
        input_type: "search_query",
        truncate: "END",
        embedding_types: ["float"],
        output_dimension: 1536,
      });
      expect(command.input?.modelId).toBe(model);
      expect(client).toMatchObject({ model, dimensions: 1536 });
      expect(provider.maxInputTokens).toBe(128_000);
    },
  );
});
