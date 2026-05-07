import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  discoverMantleModels,
  generateBearerTokenFromIam,
  getCachedIamToken,
  MANTLE_IAM_TOKEN_MARKER,
  mergeImplicitMantleProvider,
  resetIamTokenCacheForTest,
  resetMantleDiscoveryCacheForTest,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
  resolveMantleRuntimeBearerToken,
} = await import("./api.js");

function createTokenProviderFactory(tokenProvider: () => Promise<string>) {
  return vi.fn(() => tokenProvider);
}

describe("bedrock mantle discovery", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    resetMantleDiscoveryCacheForTest();
    resetIamTokenCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMantleDiscoveryCacheForTest();
    resetIamTokenCacheForTest();
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // Bearer token resolution
  // ---------------------------------------------------------------------------

  it("resolves bearer token from AWS_BEARER_TOKEN_BEDROCK", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-abc123", // pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("bedrock-api-key-abc123");
  });

  it("returns undefined when no bearer token env var is set", () => {
    expect(resolveMantleBearerToken({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("trims whitespace from bearer token", () => {
    expect(
      resolveMantleBearerToken({
        AWS_BEARER_TOKEN_BEDROCK: "  my-token  ", // pragma: allowlist secret
      } as NodeJS.ProcessEnv),
    ).toBe("my-token");
  });

  // ---------------------------------------------------------------------------
  // IAM token generation
  // ---------------------------------------------------------------------------

  it("generates token from IAM credentials when token generation succeeds", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-generated"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    const token = await generateBearerTokenFromIam({
      region: "us-east-1",
      tokenProviderFactory,
    });

    expect(token).toBe("bedrock-api-key-generated");
    expect(tokenProviderFactory).toHaveBeenCalledWith({
      region: "us-east-1",
      expiresInSeconds: 7200,
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("caches generated IAM tokens within TTL", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-cached"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);
    let now = 1000;

    const t1 = await generateBearerTokenFromIam({
      region: "us-east-1",
      now: () => now,
      tokenProviderFactory,
    });
    now += 1800_000; // 30 min — within 2hr cache TTL
    const t2 = await generateBearerTokenFromIam({
      region: "us-east-1",
      now: () => now,
      tokenProviderFactory,
    });

    expect(t1).toEqual(t2);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an IAM token across regions", async () => {
    const tokenProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("bedrock-api-key-east") // pragma: allowlist secret
      .mockResolvedValueOnce("bedrock-api-key-west"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    const east = await generateBearerTokenFromIam({
      region: "us-east-1",
      now: () => 1000,
      tokenProviderFactory,
    });
    const west = await generateBearerTokenFromIam({
      region: "us-west-2",
      now: () => 2000,
      tokenProviderFactory,
    });

    expect(east).toBe("bedrock-api-key-east");
    expect(west).toBe("bedrock-api-key-west");
    expect(tokenProviderFactory).toHaveBeenNthCalledWith(1, {
      region: "us-east-1",
      expiresInSeconds: 7200,
    });
    expect(tokenProviderFactory).toHaveBeenNthCalledWith(2, {
      region: "us-west-2",
      expiresInSeconds: 7200,
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when IAM token generation fails", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    await expect(
      generateBearerTokenFromIam({ region: "us-east-1", tokenProviderFactory }),
    ).resolves.toBeUndefined();
  });

  it("getCachedIamToken returns cached token when valid", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-cached-token"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    // Generate a token to populate the cache
    await generateBearerTokenFromIam({ region: "us-east-1", tokenProviderFactory });

    // Sync read should return the cached token
    expect(getCachedIamToken("us-east-1")).toBe("bedrock-cached-token");
  });

  it("getCachedIamToken returns undefined when cache is empty", () => {
    expect(getCachedIamToken("us-east-1")).toBeUndefined();
  });

  it("getCachedIamToken returns undefined when cache is expired", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-expired-token"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    // Generate with a time far in the past so it's already expired
    await generateBearerTokenFromIam({
      region: "us-east-1",
      now: () => 1000,
      tokenProviderFactory,
    });

    // The cache entry exists but expiresAt is 1000 + 3600000 = 3601000
    // Current Date.now() is way past that, so it should be expired
    expect(getCachedIamToken("us-east-1")).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Model discovery
  // ---------------------------------------------------------------------------

  it("discovers models from Mantle /v1/models endpoint sorted by id", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "openai.gpt-oss-120b", object: "model", owned_by: "openai" },
          { id: "anthropic.claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
          { id: "mistral.devstral-2-123b", object: "model", owned_by: "mistral" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toHaveLength(3);
    // Models should be sorted alphabetically by id
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-sonnet-4-6",
      name: "anthropic.claude-sonnet-4-6",
      reasoning: false,
      input: ["text"],
    });
    expect(models[1]).toMatchObject({
      id: "mistral.devstral-2-123b",
      reasoning: false,
    });
    expect(models[2]).toMatchObject({
      id: "openai.gpt-oss-120b",
      reasoning: true, // GPT-OSS 120B supports reasoning
    });

    // Verify correct endpoint and auth header
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("infers reasoning support from model IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "moonshotai.kimi-k2-thinking", object: "model" },
          { id: "openai.gpt-oss-120b", object: "model" },
          { id: "openai.gpt-oss-safeguard-120b", object: "model" },
          { id: "deepseek.v3.2", object: "model" },
          { id: "mistral.mistral-large-3-675b-instruct", object: "model" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["moonshotai.kimi-k2-thinking"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-120b"]?.reasoning).toBe(true);
    expect(byId["openai.gpt-oss-safeguard-120b"]?.reasoning).toBe(true);
    expect(byId["deepseek.v3.2"]?.reasoning).toBe(false);
    expect(byId["mistral.mistral-large-3-675b-instruct"]?.reasoning).toBe(false);
  });

  it("returns empty array on permission error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toEqual([]);
  });

  it("returns empty array on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toEqual([]);
  });

  it("filters out models with empty IDs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "anthropic.claude-sonnet-4-6", object: "model" },
          { id: "", object: "model" },
          { id: "  ", object: "model" },
        ],
      }),
    });

    const models = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Discovery caching
  // ---------------------------------------------------------------------------

  it("returns cached models on subsequent calls within refresh interval", async () => {
    let now = 1000000;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    });

    // First call — hits the network
    const first = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(first).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call within refresh interval — uses cache
    now += 60_000; // 1 minute later
    const second = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(second).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch

    // Third call after refresh interval — re-fetches
    now += 3600_000; // 1 hour later
    const third = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(third).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2); // Re-fetched
  });

  it("returns stale cache on fetch failure", async () => {
    let now = 1000000;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
        }),
      })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    // First call — succeeds
    await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });

    // Second call after expiry — fails but returns stale cache
    now += 7200_000;
    const stale = await discoverMantleModels({
      region: "us-east-1",
      bearerToken: "test-token",
      fetchFn: mockFetch as unknown as typeof fetch,
      now: () => now,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.id).toBe("anthropic.claude-sonnet-4-6");
  });

  // ---------------------------------------------------------------------------
  // Implicit provider resolution
  // ---------------------------------------------------------------------------

  it("resolves implicit provider when bearer token is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "anthropic.claude-sonnet-4-6", object: "model" }],
      }),
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(provider?.api).toBe("openai-completions");
    expect(provider?.auth).toBe("api-key");
    expect(provider?.apiKey).toBe("env:AWS_BEARER_TOKEN_BEDROCK");
    expect(provider?.models).toHaveLength(2);
    expect(
      provider?.models?.find((model) => model.id === "anthropic.claude-opus-4-7"),
    ).toMatchObject({
      api: "anthropic-messages",
      reasoning: false,
    });
    expect(
      provider?.models?.find((model) => model.id === "anthropic.claude-opus-4-7"),
    ).not.toHaveProperty("baseUrl");
  });

  it("returns null when no auth is available", async () => {
    const tokenProviderFactory = vi.fn(() => {
      throw new Error("no credentials");
    });

    const provider = await resolveImplicitMantleProvider({
      env: {} as NodeJS.ProcessEnv,
      tokenProviderFactory,
    });

    expect(provider).toBeNull();
  });

  it("uses a generated IAM token when no explicit token is set", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-iam"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "openai.gpt-oss-120b", object: "model" }],
      }),
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_PROFILE: "default",
        AWS_REGION: "us-east-1",
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
      tokenProviderFactory,
    });

    expect(provider).not.toBeNull();
    expect(provider?.apiKey).toBe(MANTLE_IAM_TOKEN_MARKER);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer bedrock-api-key-iam",
        }),
      }),
    );
  });

  it("resolves Mantle runtime auth from the cached IAM token marker", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-runtime"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await generateBearerTokenFromIam({
      region: "us-east-1",
      now: () => 1000,
      tokenProviderFactory,
    });

    await expect(
      resolveMantleRuntimeBearerToken({
        apiKey: MANTLE_IAM_TOKEN_MARKER,
        env: {
          AWS_REGION: "us-east-1",
        } as NodeJS.ProcessEnv,
        now: () => 2000,
        tokenProviderFactory,
      }),
    ).resolves.toMatchObject({
      apiKey: "bedrock-api-key-runtime",
      expiresAt: 1000 + 7200_000,
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("generates a fresh Mantle runtime IAM token when the cache is cold", async () => {
    const tokenProvider = vi.fn(async () => "bedrock-api-key-fresh"); // pragma: allowlist secret
    const tokenProviderFactory = createTokenProviderFactory(tokenProvider);

    await expect(
      resolveMantleRuntimeBearerToken({
        apiKey: MANTLE_IAM_TOKEN_MARKER,
        env: {
          AWS_REGION: "us-east-1",
        } as NodeJS.ProcessEnv,
        now: () => 5000,
        tokenProviderFactory,
      }),
    ).resolves.toMatchObject({
      apiKey: "bedrock-api-key-fresh",
      expiresAt: 5000 + 7200_000,
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
  });

  it("returns null for unsupported regions", async () => {
    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
        AWS_REGION: "af-south-1",
      } as NodeJS.ProcessEnv,
    });

    expect(provider).toBeNull();
  });

  it("defaults to us-east-1 when no region is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai.gpt-oss-120b", object: "model" }] }),
    });

    const provider = await resolveImplicitMantleProvider({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "my-token", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(provider?.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://bedrock-mantle.us-east-1.api.aws/v1/models",
      expect.anything(),
    );
  });

  // ---------------------------------------------------------------------------
  // Provider merging
  // ---------------------------------------------------------------------------

  it("merges implicit models when existing provider has empty models", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://custom.example.com/v1",
        models: [],
      },
      implicit: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        api: "openai-completions",
        auth: "api-key",
        apiKey: "env:AWS_BEARER_TOKEN_BEDROCK",
        models: [
          {
            id: "openai.gpt-oss-120b",
            name: "GPT-OSS 120B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    });

    expect(result.baseUrl).toBe("https://custom.example.com/v1");
    expect(result.models?.map((m) => m.id)).toEqual(["openai.gpt-oss-120b"]);
  });

  it("preserves existing models over implicit ones", () => {
    const result = mergeImplicitMantleProvider({
      existing: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        models: [
          {
            id: "custom-model",
            name: "My Custom Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 64000,
            maxTokens: 8192,
          },
        ],
      },
      implicit: {
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
        api: "openai-completions",
        auth: "api-key",
        models: [
          {
            id: "openai.gpt-oss-120b",
            name: "GPT-OSS 120B",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    });

    expect(result.models?.map((m) => m.id)).toEqual(["custom-model"]);
  });
});
