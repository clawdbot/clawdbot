import { describe, expect, it } from "vitest";

import { zalouserPlugin } from "./channel.js";

describe("zalouser outbound chunker", () => {
  it("chunks without empty strings and respects limit", () => {
    const chunker = zalouserPlugin.outbound?.chunker;
    expect(chunker).toBeTypeOf("function");
    if (!chunker) return;

    const limit = 10;
    const chunks = chunker("hello world\nthis is a test", limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= limit)).toBe(true);
  });
});
