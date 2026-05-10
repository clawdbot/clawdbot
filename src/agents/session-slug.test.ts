import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionSlug } from "./session-slug.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureInt: vi.fn(),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureInt: randomMocks.generateSecureInt,
}));

describe("session slug", () => {
  beforeEach(() => {
    randomMocks.generateSecureInt.mockReset();
  });

  it("generates a two-word slug by default", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug();
    expect(slug).toBe("amber-atlas");
  });

  it("adds a numeric suffix when the base slug is taken", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug((id) => id === "amber-atlas");
    expect(slug).toBe("amber-atlas-2");
  });

  it("falls back to three words when collisions persist", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug((id) => /^amber-atlas(-\d+)?$/.test(id));
    expect(slug).toBe("amber-atlas-atlas");
  });

  it("uses secure fallback suffix entropy when word collisions persist", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);
    const slug = createSessionSlug(
      (id) => /^amber-atlas(?:-\d+)?$/.test(id) || /^amber-atlas-atlas(?:-\d+)?$/.test(id),
    );
    expect(slug).toBe("amber-atlas-atlas-aaa");
    nowSpy.mockRestore();
  });
});
