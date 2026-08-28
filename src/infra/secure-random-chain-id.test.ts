import { describe, expect, it } from "vitest";
import { generateChainId } from "./secure-random.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("generateChainId continuation chain ids", () => {
  it("returns a UUID-shaped string", () => {
    const id = generateChainId();
    expect(id).toMatch(UUID_RE);
  });

  it("returns unique ids across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateChainId());
    }
    expect(ids.size).toBe(1000);
  });
});
