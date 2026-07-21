import { rm } from "node:fs/promises";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactToolOutputHint } from "../tool-schema-hints.js";

const { fetchWithWebToolsNetworkGuardMock, resolveWebFetchDefinitionMock } = vi.hoisted(() => ({
  fetchWithWebToolsNetworkGuardMock: vi.fn(),
  resolveWebFetchDefinitionMock: vi.fn(),
}));

vi.mock("./web-guarded-fetch.js", () => ({
  fetchWithWebToolsNetworkGuard: fetchWithWebToolsNetworkGuardMock,
}));
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: resolveWebFetchDefinitionMock,
}));

import { createWebFetchTool } from "./web-fetch.js";

const spillPaths = new Set<string>();

function mockHttpResponse(body: string, init: ResponseInit = {}): void {
  fetchWithWebToolsNetworkGuardMock.mockResolvedValue({
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      ...init,
    }),
    finalUrl: "https://example.com/final",
    release: async () => {},
  });
}

function createContractTool(options?: { cacheTtlMinutes?: number; maxChars?: number }) {
  return createWebFetchTool({
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: options?.cacheTtlMinutes ?? 0,
            maxChars: options?.maxChars,
          },
        },
      },
    },
    sandboxed: false,
  });
}

function requireDetails(result: { details?: unknown }): Record<string, unknown> {
  const details = result.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("expected web_fetch details");
  }
  return details as Record<string, unknown>;
}

const contractSchema = () => {
  const schema = createContractTool()?.outputSchema;
  if (!schema) {
    throw new Error("web_fetch outputSchema missing");
  }
  return schema;
};

function expectContract(details: Record<string, unknown>): void {
  expect(Value.Check(contractSchema(), details)).toBe(true);
}

describe("web_fetch output contract", () => {
  beforeEach(() => {
    fetchWithWebToolsNetworkGuardMock.mockReset();
    resolveWebFetchDefinitionMock.mockReset();
    resolveWebFetchDefinitionMock.mockReturnValue(null);
  });

  afterEach(async () => {
    await Promise.all([...spillPaths].map(async (path) => await rm(path, { force: true })));
    spillPaths.clear();
  });

  it("declares the exact schema and promotes its complete compact hint", () => {
    const tool = createContractTool();

    expect(tool?.outputSchema).toBeDefined();
    expect(compactToolOutputHint(tool?.outputSchema)).toBe(
      '{ externalContent: { source: "web_fetch"; untrusted: true; wrapped: true; provider?: string }; extractMode: "markdown" | "text"; extractor: string; fetchedAt: string; finalUrl: string; length: number; rawLength: number; status: number; text: string; tookMs: number; truncated: boolean; url: string; cached?: true; contentType?: string; spill?: { chars: number; path: string; truncated?: true }; title?: string; warning?: string }',
    );
  });

  it("validates the direct HTTP result and omits absent optional keys", async () => {
    mockHttpResponse("direct body");
    const result = await createContractTool()?.execute("direct", {
      url: "https://example.com/direct-contract",
    });
    const details = requireDetails(result!);

    expectContract(details);
    expect(details.length).toBe((details.text as string).length);
    expect(Object.hasOwn(details, "title")).toBe(false);
    expect(Object.hasOwn(details, "warning")).toBe(false);
    expect(Object.hasOwn(details, "spill")).toBe(false);
    expect(Object.values(details)).not.toContain(undefined);
  });

  it("validates provider-normalized results", async () => {
    fetchWithWebToolsNetworkGuardMock.mockRejectedValue(new Error("direct fetch failed"));
    resolveWebFetchDefinitionMock.mockReturnValue({
      provider: { id: "mock-provider" },
      definition: {
        description: "mock provider",
        parameters: {},
        execute: async () => ({
          finalUrl: "https://provider.example/final",
          status: 206,
          text: "provider body",
        }),
      },
    });
    const result = await createContractTool()?.execute("provider", {
      url: "https://example.com/provider-contract",
      extractMode: "text",
    });
    const details = requireDetails(result!);

    expectContract(details);
    expect(details.externalContent).toMatchObject({ provider: "mock-provider" });
    expect(Object.hasOwn(details, "contentType")).toBe(false);
    expect(Object.hasOwn(details, "title")).toBe(false);
    expect(Object.hasOwn(details, "warning")).toBe(false);
    expect(Object.values(details)).not.toContain(undefined);
  });

  it("validates cache hits without restoring removed fields", async () => {
    mockHttpResponse("cached body");
    const tool = createContractTool({ cacheTtlMinutes: 1 });
    const args = { url: "https://example.com/cache-contract" };
    const first = requireDetails((await tool?.execute("cache-first", args))!);
    const second = requireDetails((await tool?.execute("cache-second", args))!);

    expectContract(first);
    expectContract(second);
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveProperty("wrappedLength");
    expect(second).not.toHaveProperty("fullOutputPath");
    expect(second).not.toHaveProperty("spilledChars");
    expect(second).not.toHaveProperty("spillTruncated");
  });

  it("shares cached responses across equivalent URL scheme and host casing", async () => {
    mockHttpResponse("canonical URL body");
    const tool = createContractTool({ cacheTtlMinutes: 1 });

    const first = requireDetails(
      (await tool?.execute("cache-case-first", {
        url: "HTTPS://EXAMPLE.COM/cache-case-contract",
      }))!,
    );
    const second = requireDetails(
      (await tool?.execute("cache-case-second", {
        url: "https://example.com/cache-case-contract",
      }))!,
    );

    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(fetchWithWebToolsNetworkGuardMock).toHaveBeenCalledTimes(1);
  });

  it("validates nested spill metadata", async () => {
    mockHttpResponse("spill body ".repeat(1_000));
    const result = await createContractTool({ maxChars: 300 })?.execute("spill", {
      url: "https://example.com/spill-contract",
    });
    const details = requireDetails(result!);
    const spill = details.spill as { path: string; chars: number; truncated?: true } | undefined;
    if (!spill) {
      throw new Error("expected spill metadata");
    }
    spillPaths.add(spill.path);

    expectContract(details);
    expect(spill.chars).toBe("spill body ".repeat(1_000).length);
    expect(spill.truncated).toBeUndefined();
    expect(details.text).toContain(`Full output: ${spill.path}`);
  });

  it("throws HTTP errors instead of returning an undeclared error shape", async () => {
    mockHttpResponse("missing", { status: 404, statusText: "Not Found" });

    await expect(
      createContractTool()?.execute("error", { url: "https://example.com/error-contract" }),
    ).rejects.toThrow("Web fetch failed (404)");
  });
});
