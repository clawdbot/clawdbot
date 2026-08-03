// Amazon Bedrock tests cover embedding provider plugin behavior.
import { createHash, createHmac } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockEmbeddingProvider, hasAwsCredentials } from "./embedding-provider.js";
import { embeddingTesting as testing } from "./test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function isValidBedrockSigV4(
  headers: Record<string, string | string[] | undefined>,
  path: string,
): boolean {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") {
    return false;
  }
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(
      authorization,
    );
  if (!match) {
    return false;
  }
  const [, accessKey, date, region, service, signedHeaders, signature] = match;
  if (accessKey !== "bedrock-test-access") {
    return false;
  }
  const escapeUri = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const queryStart = path.indexOf("?");
  const pathname = queryStart < 0 ? path : path.slice(0, queryStart);
  const query = queryStart < 0 ? "" : path.slice(queryStart + 1);
  const canonicalQuery = query
    ? query
        .split("&")
        .map((parameter) => {
          const separator = parameter.indexOf("=");
          const key = decodeURIComponent(separator < 0 ? parameter : parameter.slice(0, separator));
          const value = decodeURIComponent(separator < 0 ? "" : parameter.slice(separator + 1));
          return `${escapeUri(key)}=${escapeUri(value)}`;
        })
        .toSorted()
        .join("&")
    : "";
  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => {
      const value = headers[name];
      const text = Array.isArray(value) ? value.join(",") : (value ?? "");
      return `${name}:${text.trim().replace(/\s+/gu, " ")}`;
    })
    .join("\n");
  const canonicalRequest = [
    "POST",
    escapeUri(pathname).replace(/%2F/gu, "/"),
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    headers["x-amz-content-sha256"],
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headers["x-amz-date"],
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let key: Buffer = Buffer.from("AWS4bedrock-test-secret");
  for (const value of [date, region, service, "aws4_request"]) {
    key = createHmac("sha256", key).update(value).digest();
  }
  return createHmac("sha256", key).update(stringToSign).digest("hex") === signature;
}

async function expectSignedBedrockEndpoint(endpoint: string): Promise<void> {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "bedrock-test-access");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "bedrock-test-secret");
  vi.stubEnv("AWS_SESSION_TOKEN", undefined);
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
  vi.stubEnv("AWS_PROFILE", "");

  const observedRequests: Array<{ authority: string; authorization: string }> = [];
  const server = createServer();
  server.on("stream", (stream, headers) => {
    observedRequests.push({
      authority: headers[":authority"] ?? "",
      authorization: headers.authorization ?? "",
    });
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(JSON.stringify({ embedding: [3, 4] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const transport = new NodeHttp2Handler();
  const sdk = new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint,
    requestHandler: {
      metadata: { handlerProtocol: "h2" },
      handle: (request, options) =>
        transport.handle(
          { ...request, protocol: "http:", hostname: "127.0.0.1", port: address.port },
          options,
        ),
      destroy: () => transport.destroy(),
    },
  });

  try {
    await sdk.send(
      new InvokeModelCommand({
        modelId: "amazon.titan-embed-text-v2:0",
        body: "{}",
        contentType: "application/json",
        accept: "application/json",
      }),
    );
    expect(observedRequests).toEqual([
      {
        authority: new URL(endpoint).host,
        authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=bedrock-test-access\//),
      },
    ]);
  } finally {
    sdk.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

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
    expect(client).not.toHaveProperty("endpoint");
  });

  it.each([
    {
      name: "regional PrivateLink endpoint",
      endpoint: "https://vpce-123.bedrock-runtime.eu-west-1.vpce.amazonaws.com",
    },
    {
      name: "FIPS PrivateLink endpoint",
      endpoint: "https://vpce-123.bedrock-runtime-fips.eu-west-1.vpce.amazonaws.com",
    },
  ])("infers the signing region from an SDK-owned $name", async ({ endpoint }) => {
    vi.stubEnv("AWS_REGION", "us-east-1");

    const { client } = await createBedrockEmbeddingProvider({
      config: {},
      model: "amazon.titan-embed-text-v2:0",
      remote: { baseUrl: endpoint },
    });

    expect(client.region).toBe("eu-west-1");
    expect(client.endpoint).toBe(endpoint);
  });

  it("preserves AWS FIPS region aliases for SDK-managed standard endpoints", async () => {
    vi.stubEnv("AWS_REGION", "fips-eu-west-1");

    const { client } = await createBedrockEmbeddingProvider({ config: {}, model: "" });
    const sdk = new BedrockRuntimeClient({ region: client.region });
    try {
      expect(client.region).toBe("fips-eu-west-1");
      expect(client).not.toHaveProperty("endpoint");
      expect(await sdk.config.region()).toBe("eu-west-1");
      expect(await sdk.config.useFipsEndpoint()).toBe(true);
    } finally {
      sdk.destroy();
    }
  });
});

describe("bedrock embedding endpoint ownership", () => {
  it.each([
    {
      name: "memory endpoint with SigV4",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
    },
    {
      name: "provider endpoint with SigV4",
      source: "provider",
      auth: "sigv4",
      providerRegion: undefined,
    },
    {
      name: "memory endpoint with Bedrock bearer auth",
      source: "remote",
      auth: "bearer",
      providerRegion: undefined,
    },
    {
      name: "memory endpoint with its provider-configured signing region",
      source: "remote",
      auth: "sigv4",
      providerRegion: "us-east-1",
    },
    {
      name: "custom endpoint when inherited FIPS mode is enabled",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointModes: ["AWS_USE_FIPS_ENDPOINT"],
    },
    {
      name: "custom endpoint when inherited dual-stack mode is enabled",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointModes: ["AWS_USE_DUALSTACK_ENDPOINT"],
    },
    {
      name: "custom endpoint when inherited FIPS and dual-stack modes are enabled",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointModes: ["AWS_USE_FIPS_ENDPOINT", "AWS_USE_DUALSTACK_ENDPOINT"],
    },
    {
      name: "custom endpoint when its configured region is an AWS FIPS alias",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      awsRegion: "fips-eu-west-1",
      expectedSigningRegion: "eu-west-1",
    },
    {
      name: "FIPS-looking private endpoint with its provider-configured signing region",
      source: "remote",
      auth: "sigv4",
      providerRegion: "us-east-1",
      proxyHostname: "bedrock-runtime-fips.us-west-2.private.test",
    },
    {
      name: "FIPS-looking private endpoint with its environment-configured signing region",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      proxyHostname: "bedrock-runtime-fips.us-west-2.private.test",
    },
    {
      name: "AWS-suffix-looking private endpoint with its provider-configured signing region",
      source: "remote",
      auth: "sigv4",
      providerRegion: "us-east-1",
      proxyHostname: "bedrock-runtime-fips.us-west-2.amazonaws.com.private.test",
    },
    {
      name: "memory proxy endpoint with a trailing slash in its query value",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointQuery: "?upstream=https://bedrock/",
    },
    {
      name: "memory proxy endpoint with repeated upstream query parameters",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointQuery: "?upstream=https://bedrock/&upstream=https://second/",
    },
    {
      name: "SigV4 proxy endpoint with interleaved repeated query parameters",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointQuery: "?upstream=first&mode=failover&upstream=second",
    },
    {
      name: "bearer proxy endpoint with interleaved repeated query parameters",
      source: "remote",
      auth: "bearer",
      providerRegion: undefined,
      endpointQuery: "?upstream=first&mode=failover&upstream=second",
    },
    {
      name: "SigV4 proxy endpoint preserving raw pluses, escapes, equals, and flag parameters",
      source: "remote",
      auth: "sigv4",
      providerRegion: undefined,
      endpointQuery: "?upstream=a+b&mode=fail%20over&upstream=a%2Bb&token=a=b&flag",
    },
  ] as const)(
    "sends authenticated embedding requests to the configured $name",
    async (testCase) => {
      const { source, auth, providerRegion } = testCase;
      const endpointQuery = "endpointQuery" in testCase ? testCase.endpointQuery : "";
      const configuredRequests: Array<{
        url: string | undefined;
        authorization: string;
        signatureValid?: boolean;
      }> = [];
      const fallbackRequests: string[] = [];
      const openSessions = new Set<ServerHttp2Session>();
      const configuredServer = createServer();
      configuredServer.on("stream", (stream, headers) => {
        configuredRequests.push({
          url: headers[":path"],
          authorization: headers.authorization ?? "",
          ...(headers.authorization?.startsWith("AWS4-HMAC-SHA256")
            ? { signatureValid: isValidBedrockSigV4(headers, headers[":path"] ?? "") }
            : {}),
        });
        stream.respond({ ":status": 200, "content-type": "application/json" });
        stream.end(JSON.stringify({ embedding: [3, 4] }));
      });
      const fallbackServer = createServer();
      fallbackServer.on("stream", (stream, headers) => {
        fallbackRequests.push(headers[":path"] ?? "");
        stream.respond({ ":status": 200, "content-type": "application/json" });
        stream.end(JSON.stringify({ embedding: [0, 1] }));
      });
      for (const server of [configuredServer, fallbackServer]) {
        server.on("session", (session) => {
          openSessions.add(session);
          session.once("close", () => openSessions.delete(session));
        });
      }
      configuredServer.listen(0, "127.0.0.1");
      fallbackServer.listen(0, "127.0.0.1");
      await Promise.all([once(configuredServer, "listening"), once(fallbackServer, "listening")]);
      const configuredAddress = configuredServer.address() as AddressInfo;
      const fallbackAddress = fallbackServer.address() as AddressInfo;
      const proxyHostname = "proxyHostname" in testCase ? testCase.proxyHostname : undefined;
      const endpoint = `http://${proxyHostname ?? "127.0.0.1"}:${configuredAddress.port}`;
      const paddedEndpoint = `  ${endpoint}/${endpointQuery}  `;
      const fallbackEndpoint = `http://127.0.0.1:${fallbackAddress.port}`;
      const configuredRegion = "awsRegion" in testCase ? testCase.awsRegion : "eu-west-1";
      const signingRegion =
        providerRegion ??
        ("expectedSigningRegion" in testCase ? testCase.expectedSigningRegion : configuredRegion);
      vi.stubEnv("AWS_REGION", configuredRegion);
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", undefined);
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", undefined);
      vi.stubEnv("AWS_ACCESS_KEY_ID", auth === "sigv4" ? "bedrock-test-access" : undefined);
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", auth === "sigv4" ? "bedrock-test-secret" : undefined);
      vi.stubEnv("AWS_SESSION_TOKEN", undefined);
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", auth === "bearer" ? "bedrock-test-token" : undefined);
      vi.stubEnv("AWS_PROFILE", "");
      // Keep the unfixed SDK path on localhost while proving configured endpoints win.
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", fallbackEndpoint);
      if ("endpointModes" in testCase) {
        for (const endpointMode of testCase.endpointModes) {
          vi.stubEnv(endpointMode, "true");
        }
      }
      if (proxyHostname) {
        const lookup = dns.lookup.bind(dns);
        vi.spyOn(dns, "lookup").mockImplementation((hostname, ...args) =>
          lookup(hostname === proxyHostname ? "127.0.0.1" : hostname, ...args),
        );
      }

      try {
        const { provider, client } = await createBedrockEmbeddingProvider({
          config:
            source === "provider"
              ? {
                  models: {
                    providers: { "amazon-bedrock": { baseUrl: paddedEndpoint, models: [] } },
                  },
                }
              : {
                  models: {
                    providers: {
                      "amazon-bedrock": {
                        baseUrl: providerRegion
                          ? `https://bedrock-runtime.${providerRegion}.amazonaws.com`
                          : fallbackEndpoint,
                        models: [],
                      },
                    },
                  },
                },
          model: "amazon.titan-embed-text-v2:0",
          ...(source === "remote" ? { remote: { baseUrl: paddedEndpoint } } : {}),
        });

        await expect(
          provider.embedQuery("route this embedding to its configured owner"),
        ).resolves.toEqual([0.6, 0.8]);
        expect(client.region).toBe(signingRegion);
        expect(client.endpoint).toBe(`${endpoint}${endpointQuery}`);
        expect(configuredRequests).toHaveLength(1);
        expect(configuredRequests[0]).toMatchObject({
          url: `/model/amazon.titan-embed-text-v2%3A0/invoke${endpointQuery}`,
          authorization:
            auth === "bearer"
              ? "Bearer bedrock-test-token"
              : expect.stringMatching(
                  new RegExp(
                    `^AWS4-HMAC-SHA256 Credential=bedrock-test-access/\\d{8}/${signingRegion}/bedrock/aws4_request, `,
                  ),
                ),
          ...(auth === "sigv4" ? { signatureValid: true } : {}),
        });
        expect(fallbackRequests).toEqual([]);
      } finally {
        for (const session of openSessions) {
          session.destroy();
        }
        await Promise.all([
          new Promise<void>((resolve, reject) => {
            configuredServer.close((error) => (error ? reject(error) : resolve()));
          }),
          new Promise<void>((resolve, reject) => {
            fallbackServer.close((error) => (error ? reject(error) : resolve()));
          }),
        ]);
      }
    },
  );

  it.each([
    {
      env: "AWS_USE_FIPS_ENDPOINT",
      mode: "FIPS",
      hostnamePrefix: "bedrock-runtime-fips",
      configuredHost: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
    },
    {
      env: "AWS_USE_FIPS_ENDPOINT",
      mode: "an already-canonical FIPS",
      hostnamePrefix: "bedrock-runtime-fips",
      configuredHost: "bedrock-runtime-fips.us-east-1.amazonaws.com",
      region: "us-east-1",
    },
    {
      env: "AWS_USE_FIPS_ENDPOINT",
      mode: "a configured FIPS region overriding the environment",
      hostnamePrefix: "bedrock-runtime-fips",
      configuredHost: "bedrock-runtime-fips.us-west-2.amazonaws.com",
      region: "us-west-2",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "an already-canonical dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.us-east-1.api.aws",
      region: "us-east-1",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "China dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.cn-north-1.api.amazonwebservices.com.cn",
      region: "cn-north-1",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "European sovereign dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.eusc-de-east-1.api.amazonwebservices.eu",
      region: "eusc-de-east-1",
    },
    {
      env: "AWS_USE_FIPS_ENDPOINT",
      mode: "AWS ISO FIPS",
      hostnamePrefix: "bedrock-runtime-fips",
      configuredHost: "bedrock-runtime.us-iso-east-1.c2s.ic.gov",
      region: "us-iso-east-1",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "AWS ISO-B dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.us-isob-east-1.api.aws.scloud",
      region: "us-isob-east-1",
    },
    {
      env: "AWS_USE_FIPS_ENDPOINT",
      mode: "AWS ISO-E FIPS",
      hostnamePrefix: "bedrock-runtime-fips",
      configuredHost: "bedrock-runtime.eu-isoe-west-1.cloud.adc-e.uk",
      region: "eu-isoe-west-1",
    },
    {
      env: "AWS_USE_DUALSTACK_ENDPOINT",
      mode: "AWS ISO-F dual-stack",
      hostnamePrefix: "bedrock-runtime",
      configuredHost: "bedrock-runtime.us-isof-south-1.api.aws.hci.ic.gov",
      region: "us-isof-south-1",
    },
  ])("preserves SDK-managed $mode routing for standard Bedrock endpoints", async (testCase) => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_USE_FIPS_ENDPOINT", undefined);
    vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
    vi.stubEnv(testCase.env, "true");
    const { client } = await createBedrockEmbeddingProvider({
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: `https://${testCase.configuredHost}/`,
              models: [],
            },
          },
        },
      },
      model: "amazon.titan-embed-text-v2:0",
    });
    const sdk = new BedrockRuntimeClient({
      region: client.region,
      ...(client.endpoint ? { endpoint: client.endpoint } : {}),
    });

    try {
      const resolved = sdk.config.endpointProvider({
        Region: client.region,
        UseFIPS: await sdk.config.useFipsEndpoint(),
        UseDualStack: await sdk.config.useDualstackEndpoint(),
        ...(client.endpoint ? { Endpoint: client.endpoint } : {}),
      });

      expect(resolved.url.hostname).toMatch(
        new RegExp(`^${testCase.hostnamePrefix}\\.${testCase.region}\\.`),
      );
      expect(client).not.toHaveProperty("endpoint");
    } finally {
      sdk.destroy();
    }
  });

  it.each([
    {
      mode: "FIPS",
      endpoint: "https://bedrock-runtime-fips.us-east-1.amazonaws.com",
    },
    {
      mode: "dual-stack",
      endpoint: "https://bedrock-runtime.us-east-1.api.aws",
    },
    {
      mode: "combined FIPS and dual-stack",
      endpoint: "https://bedrock-runtime-fips.us-east-1.api.aws",
    },
  ])(
    "preserves an explicitly configured $mode endpoint when SDK flags are disabled",
    async ({ endpoint }) => {
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);

      const { client } = await createBedrockEmbeddingProvider({
        config: {
          models: {
            providers: { "amazon-bedrock": { baseUrl: endpoint, models: [] } },
          },
        },
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(client.endpoint).toBe(endpoint);
      const sdk = new BedrockRuntimeClient({ region: client.region, endpoint: client.endpoint });
      try {
        const resolved = sdk.config.endpointProvider({
          Region: client.region,
          UseFIPS: await sdk.config.useFipsEndpoint(),
          UseDualStack: await sdk.config.useDualstackEndpoint(),
          Endpoint: client.endpoint,
        });
        expect(resolved.url.href).toBe(`${endpoint}/`);
      } finally {
        sdk.destroy();
      }
      await expectSignedBedrockEndpoint(endpoint);
    },
  );

  it.each(["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL"] as const)(
    "does not route an explicitly configured standard endpoint to conflicting %s",
    async (overrideName) => {
      const endpoint = "https://bedrock-runtime.us-east-1.amazonaws.com";
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
      vi.stubEnv(overrideName, "http://127.0.0.1:41234");

      const { client } = await createBedrockEmbeddingProvider({
        config: {
          models: {
            providers: { "amazon-bedrock": { baseUrl: endpoint, models: [] } },
          },
        },
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(client.endpoint).toBe(endpoint);
      const sdk = new BedrockRuntimeClient({ region: client.region, endpoint: client.endpoint });
      try {
        const resolved = sdk.config.endpointProvider({
          Region: client.region,
          UseFIPS: await sdk.config.useFipsEndpoint(),
          UseDualStack: await sdk.config.useDualstackEndpoint(),
          Endpoint: client.endpoint,
        });
        expect(resolved.url.hostname).toBe("bedrock-runtime.us-east-1.amazonaws.com");
      } finally {
        sdk.destroy();
      }
      await expectSignedBedrockEndpoint(endpoint);
    },
  );

  it.each(["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL"] as const)(
    "retains an explicitly configured custom endpoint matching %s",
    async (overrideName) => {
      const endpoint = "https://proxy-a.internal.example";
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
      vi.stubEnv(overrideName, endpoint);

      const { client } = await createBedrockEmbeddingProvider({
        config: {
          models: {
            providers: { "amazon-bedrock": { baseUrl: endpoint, models: [] } },
          },
        },
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(client.endpoint).toBe(endpoint);
      await expectSignedBedrockEndpoint(endpoint);
    },
  );

  it.each(["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL"] as const)(
    "keeps an actual regional endpoint matching %s SDK-owned",
    async (overrideName) => {
      const endpoint = "https://bedrock-runtime.us-east-1.amazonaws.com";
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
      vi.stubEnv(overrideName, endpoint);

      const { client } = await createBedrockEmbeddingProvider({
        config: {
          models: {
            providers: { "amazon-bedrock": { baseUrl: endpoint, models: [] } },
          },
        },
        model: "amazon.titan-embed-text-v2:0",
      });

      expect(client).not.toHaveProperty("endpoint");
      await expectSignedBedrockEndpoint(endpoint);
    },
  );

  it.each(["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_ENDPOINT_URL"] as const)(
    "retains a custom %s endpoint even without explicit OpenClaw configuration",
    async (overrideName) => {
      const endpoint = "https://proxy-a.internal.example";
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
      vi.stubEnv(overrideName, endpoint);

      const { client } = await createBedrockEmbeddingProvider({ config: {}, model: "" });

      expect(client.endpoint).toBe(endpoint);
      await expectSignedBedrockEndpoint(endpoint);
    },
  );

  it("keeps a genuine regional SDK override out of default embedding cache identity", async () => {
    const endpoint = "https://bedrock-runtime.us-east-1.amazonaws.com";
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
    vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", endpoint);

    const { client } = await createBedrockEmbeddingProvider({ config: {}, model: "" });

    expect(client).not.toHaveProperty("endpoint");
    await expectSignedBedrockEndpoint(endpoint);
  });

  it("prefers the service-specific custom endpoint over a global SDK override", async () => {
    const serviceEndpoint = "https://service-proxy.internal.example";
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
    vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
    vi.stubEnv("AWS_ENDPOINT_URL", "https://global-proxy.internal.example");
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", serviceEndpoint);

    const { client } = await createBedrockEmbeddingProvider({ config: {}, model: "" });

    expect(client.endpoint).toBe(serviceEndpoint);
    await expectSignedBedrockEndpoint(serviceEndpoint);
  });

  it.each([
    {
      flag: "AWS_USE_FIPS_ENDPOINT",
      expectedHost: "bedrock-runtime-fips.us-east-1.amazonaws.com",
    },
    {
      flag: "AWS_USE_DUALSTACK_ENDPOINT",
      expectedHost: "bedrock-runtime.us-east-1.api.aws",
    },
  ] as const)(
    "retains inherited $flag routing when no endpoint is configured",
    async ({ flag, expectedHost }) => {
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", undefined);
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL", undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
      vi.stubEnv(flag, "true");

      const { client } = await createBedrockEmbeddingProvider({ config: {}, model: "" });
      expect(client).not.toHaveProperty("endpoint");

      const sdk = new BedrockRuntimeClient({ region: client.region });
      try {
        const resolved = sdk.config.endpointProvider({
          Region: client.region,
          UseFIPS: await sdk.config.useFipsEndpoint(),
          UseDualStack: await sdk.config.useDualstackEndpoint(),
        });
        expect(resolved.url.hostname).toBe(expectedHost);
      } finally {
        sdk.destroy();
      }
    },
  );

  it.each([
    "https://vpce-123.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    "https://bedrock-runtime.us-east-1.amazonaws.com/proxy",
    "https://bedrock-runtime.us-east-1.amazonaws.com?proxy=1",
    "https://bedrock-runtime.us-east-1.amazonaws.com?proxy=https://bedrock/",
    "https://bedrock-runtime.us-east-1.amazonaws.com?proxy=1#cursor=/",
    "http://bedrock-runtime.us-east-1.amazonaws.com",
  ])("keeps noncanonical Bedrock endpoint %s explicit", async (endpoint) => {
    const { client } = await createBedrockEmbeddingProvider({
      config: {
        models: {
          providers: {
            "amazon-bedrock": { baseUrl: endpoint, models: [] },
          },
        },
      },
      model: "amazon.titan-embed-text-v2:0",
    });

    expect(client.endpoint).toBe(endpoint);
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
