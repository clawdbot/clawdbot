import { describe, expect, it } from "vitest";
import { buildCatalogSessionKey, parseCatalogSessionKey } from "./catalog-key.ts";

describe("catalog session keys", () => {
  it("round-trips encoded host and thread ids", () => {
    const key = { catalogId: "claude", hostId: "node:abc", threadId: "thread:a/b" };
    expect(parseCatalogSessionKey(buildCatalogSessionKey(key))).toEqual(key);
  });

  it.each(["", "catalog:", "catalog:a:b", "catalog:a:b:c:d", "catalog:a:%:c"])(
    "rejects %s",
    (value) => expect(parseCatalogSessionKey(value)).toBeNull(),
  );
});
