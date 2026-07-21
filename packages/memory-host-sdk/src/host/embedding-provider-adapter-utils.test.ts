import { describe, expect, it } from "vitest";
import {
  buildEmbeddingEndpointCacheIdentity,
  sanitizeEmbeddingCacheHeaders,
} from "./embedding-provider-adapter-utils.js";

describe("sanitizeEmbeddingCacheHeaders", () => {
  it("removes only explicitly excluded header names", () => {
    expect(
      sanitizeEmbeddingCacheHeaders(
        {
          Authorization: "Bearer redacted", // pragma: allowlist secret
          "X-Api-Key": "redacted", // pragma: allowlist secret
          "X-Api-Key-Routing": "tenant-a",
          "X-Token-Bucket": "batch-a",
        },
        ["authorization", "x-api-key"],
      ),
    ).toEqual([
      ["X-Api-Key-Routing", "tenant-a"],
      ["X-Token-Bucket", "batch-a"],
    ]);
  });
});

describe("buildEmbeddingEndpointCacheIdentity", () => {
  const DEFAULT = "https://api.example.ai/v1";
  const auth = { Authorization: "Bearer redacted" }; // pragma: allowlist secret

  it("keeps the shipped default identity (no extra fields) so ordinary installs do not rebuild", () => {
    expect(
      buildEmbeddingEndpointCacheIdentity({
        baseUrl: DEFAULT,
        defaultBaseUrl: DEFAULT,
        headers: auth,
      }),
    ).toEqual({});
  });

  it("scopes identity by base URL when a custom endpoint is configured", () => {
    expect(
      buildEmbeddingEndpointCacheIdentity({
        baseUrl: "https://proxy.internal/v1",
        defaultBaseUrl: DEFAULT,
        headers: auth,
      }),
    ).toEqual({ baseUrl: "https://proxy.internal/v1" });
  });

  it("hashes custom header identity without retaining raw values, and forces base-url scoping", () => {
    const identity = buildEmbeddingEndpointCacheIdentity({
      baseUrl: DEFAULT,
      defaultBaseUrl: DEFAULT,
      headers: { ...auth, "X-Api-Key-Routing": "tenant-a" },
    });
    expect(identity.baseUrl).toBe(DEFAULT);
    expect(identity.headersHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(identity)).not.toContain("tenant-a");
  });

  it("gives distinct header hashes for distinct header identity", () => {
    const a = buildEmbeddingEndpointCacheIdentity({
      baseUrl: DEFAULT,
      defaultBaseUrl: DEFAULT,
      headers: { "X-Api-Key-Routing": "tenant-a" },
    });
    const b = buildEmbeddingEndpointCacheIdentity({
      baseUrl: DEFAULT,
      defaultBaseUrl: DEFAULT,
      headers: { "X-Api-Key-Routing": "tenant-b" },
    });
    expect(a.headersHash).not.toBe(b.headersHash);
  });
});
