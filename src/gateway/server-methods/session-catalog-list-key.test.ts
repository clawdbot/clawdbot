import { describe, expect, it } from "vitest";
import { sessionCatalogListKey } from "./session-catalog-list-key.js";

function key(request: Parameters<typeof sessionCatalogListKey>[0]["request"]): string {
  return sessionCatalogListKey({ agentId: "main", request });
}

describe("sessionCatalogListKey", () => {
  it("treats host ids as a set", () => {
    expect(key({ hostIds: ["host-b", "host-a", "host-a"] })).toBe(
      key({ hostIds: ["host-a", "host-b"] }),
    );
  });

  it("keeps different, empty, and omitted host filters distinct", () => {
    expect(key({ hostIds: ["host-a", "host-b"] })).not.toBe(key({ hostIds: ["host-a", "host-c"] }));
    expect(key({ hostIds: [] })).not.toBe(key({}));
  });

  it("canonicalizes cursor order without merging different cursors", () => {
    expect(key({ cursors: { beta: "2", alpha: "1" } })).toBe(
      key({ cursors: { alpha: "1", beta: "2" } }),
    );
    expect(key({ cursors: { alpha: "1" } })).not.toBe(key({ cursors: { alpha: "2" } }));
  });
});
