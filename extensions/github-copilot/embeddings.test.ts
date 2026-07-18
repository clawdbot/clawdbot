// Github Copilot tests cover embeddings plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotApiTokenMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputStringMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({
  resolveFirstGithubToken: resolveFirstGithubTokenMock,
}));

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputString: resolveConfiguredSecretInputStringMock,
}));

vi.mock("./token.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://example.test",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";

afterAll(() => {
  vi.doUnmock("./auth.js");
  vi.doUnmock("openclaw/plugin-sdk/secret-input-runtime");
  vi.doUnmock("./token.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

const TEST_BASE_URL = "https://example.test";

function shouldContinueAutoSelection(error: Error): boolean {
  const shouldContinue = githubCopilotMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection;
  if (!shouldContinue) {
    throw new Error("GitHub Copilot embedding adapter did not expose auto-selection fallback");
  }
  return shouldContinue(error);
}

function buildModelsResponse(models: Array<{ id: string; supported_endpoints?: unknown }>) {
  return { data: models };
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function mockDiscoveryResponse(spec: {
  ok: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}) {
  const status = spec.status ?? (spec.ok ? 200 : 500);
  const response =
    spec.json !== undefined
      ? new Response(JSON.stringify(spec.json), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      : new Response(spec.text ?? "", { status });
  fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
    response,
    release: vi.fn(async () => {}),
  }));
}

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

function firstCopilotApiTokenRequest() {
  const [call] = resolveCopilotApiTokenMock.mock.calls;
  if (!call) {
    throw new Error("expected resolveCopilotApiToken call");
  }
  const [request] = call;
  if (!request || typeof request !== "object") {
    throw new Error("expected resolveCopilotApiToken request");
  }
  return request as { env?: typeof process.env; githubToken?: string };
}

function firstDiscoveryRequest() {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected GitHub Copilot discovery request");
  }
  const [request] = call;
  if (!request || typeof request !== "object") {
    throw new Error("expected GitHub Copilot discovery request options");
  }
  return request as {
    init: { headers: Record<string, string> };
    url: string;
  };
}

describe("githubCopilotMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    resolveConfiguredSecretInputStringMock.mockResolvedValue({});
    resolveFirstGithubTokenMock.mockResolvedValue({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: "test-token-placeholder",
      expiresAt: Date.now() + 3_600_000,
      source: "test",
      baseUrl: TEST_BASE_URL,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resolveConfiguredSecretInputStringMock.mockReset();
    resolveFirstGithubTokenMock.mockReset();
    resolveCopilotApiTokenMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers the expected adapter metadata", () => {
    expect(githubCopilotMemoryEmbeddingProviderAdapter.id).toBe("github-copilot");
    expect(githubCopilotMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(githubCopilotMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(15);
    expect(githubCopilotMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
  });

  it("picks text-embedding-3-small when available", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-large", supported_endpoints: ["/v1/embeddings"] },
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
        { id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.model).toBe("text-embedding-3-small");
    expect(firstCopilotApiTokenRequest().githubToken).toBe("test-token-placeholder");
  });

  it("matches embedding-capable models when supported_endpoints is missing or malformed", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "gpt-4o", supported_endpoints: { broken: true } },
        { id: "text-embedding-3-small", supported_endpoints: [] },
        { id: "text-embedding-ada-002" },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.model).toBe("text-embedding-3-small");
  });

  it("strips the provider prefix from a user-selected model", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      model: "github-copilot/text-embedding-3-small",
    } as never);

    expect(result.provider?.model).toBe("text-embedding-3-small");
  });

  it("throws when the user-selected model is unavailable", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        model: "gpt-4o",
      } as never),
    ).rejects.toThrow('GitHub Copilot embedding model "gpt-4o" is not available');
  });

  it("throws when discovery finds no embedding models", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([{ id: "gpt-4o", supported_endpoints: ["/v1/chat/completions"] }]),
    });

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow("No embedding models available from GitHub Copilot");
  });

  it("wraps invalid discovery JSON as a setup error", async () => {
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
      response: new Response("not-valid-json{{{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    }));

    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow("github-copilot.model-discovery: malformed JSON response");
  });

  it("bounds model discovery error bodies", async () => {
    const tracked = cancelTrackedResponse(`${"discovery denied ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => ({
      response: tracked.response,
      release: vi.fn(async () => {}),
    }));

    let caught: Error | undefined;
    try {
      await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("GitHub Copilot model discovery HTTP 503");
    expect(caught?.message).toContain("discovery denied");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("bounds embeddings error bodies", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });
    const tracked = cancelTrackedResponse(`${"embedding denied ".repeat(1024)}tail`, {
      status: 429,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchImpl = vi.fn(async () => tracked.response);
    vi.stubGlobal("fetch", fetchImpl);
    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    let caught: Error | undefined;
    try {
      await result.provider?.embedQuery("hello");
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain("GitHub Copilot embeddings HTTP 429");
    expect(caught?.message).toContain("embedding denied");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_300);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("honors remote overrides when creating the provider", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    await githubCopilotMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      remote: {
        apiKey: "test-token-placeholder",
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Proxy-Token": "test-token-placeholder" },
      },
    } as never);

    expect(resolveFirstGithubTokenMock).not.toHaveBeenCalled();
    expect(resolveConfiguredSecretInputStringMock).not.toHaveBeenCalled();
    expect(firstCopilotApiTokenRequest().env).toBe(process.env);
    expect(firstCopilotApiTokenRequest().githubToken).toBe("test-token-placeholder");

    const discoveryCall = firstDiscoveryRequest();
    expect(discoveryCall.url).toBe("https://proxy.example/v1/models");
    expect(discoveryCall.init.headers["Accept-Encoding"]).toBe("identity");
    expect(discoveryCall.init.headers["X-Proxy-Token"]).toBe("test-token-placeholder");
  });

  it("rejects an unresolved remote ref without falling back to another profile", async () => {
    await expect(
      githubCopilotMemoryEmbeddingProviderAdapter.create({
        ...defaultCreateOptions(),
        remote: {
          apiKey: { source: "env", provider: "default", id: "MISSING_TEST_VALUE" },
        },
      } as never),
    ).rejects.toMatchObject({
      name: "UnresolvedSecretInputError",
      path: "agents.*.memorySearch.remote.apiKey",
    });
    expect(resolveFirstGithubTokenMock).not.toHaveBeenCalled();
    expect(resolveCopilotApiTokenMock).not.toHaveBeenCalled();
    expect(resolveConfiguredSecretInputStringMock).not.toHaveBeenCalled();
  });

  it("includes provider, baseUrl, and model in runtime cache data", async () => {
    mockDiscoveryResponse({
      ok: true,
      json: buildModelsResponse([
        { id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] },
      ]),
    });

    const result = await githubCopilotMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.runtime).toEqual({
      id: "github-copilot",
      cacheKeyData: {
        provider: "github-copilot",
        baseUrl: TEST_BASE_URL,
        model: "text-embedding-3-small",
      },
    });
  });

  it("treats token parsing and discovery failures as auto-fallback errors", () => {
    expect(shouldContinueAutoSelection(new Error("Copilot token response missing token"))).toBe(
      true,
    );
    expect(
      shouldContinueAutoSelection(
        new Error("Unexpected response from GitHub Copilot token endpoint"),
      ),
    ).toBe(true);
    expect(
      shouldContinueAutoSelection(
        new Error("github-copilot.model-discovery: malformed JSON response"),
      ),
    ).toBe(true);
    expect(
      shouldContinueAutoSelection(
        new Error("Copilot token exchange failed: timed out after 30000ms"),
      ),
    ).toBe(true);
    expect(shouldContinueAutoSelection(new Error("Network timeout"))).toBe(false);
  });
});
