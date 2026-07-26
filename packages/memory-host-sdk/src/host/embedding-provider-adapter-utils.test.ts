import { describe, expect, it } from "vitest";
import { sanitizeEmbeddingCacheHeaders } from "./embedding-provider-adapter-utils.js";

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
