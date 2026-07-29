import { describe, expect, it } from "vitest";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";

describe("buildSandboxContainerName", () => {
  it("preserves scope identity when a custom prefix exceeds the Docker name limit", () => {
    const commonPrefix = "custom-prefix-".repeat(6);
    const first = buildSandboxContainerName(
      `${commonPrefix}first`,
      slugifySessionKey("session:first"),
    );
    const second = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:second"),
    );
    const sameScopeDifferentPrefix = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:first"),
    );
    const oversizedSlug = buildSandboxContainerName(
      commonPrefix,
      slugifySessionKey("session:".concat("x".repeat(200))),
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(sameScopeDifferentPrefix);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(oversizedSlug).toHaveLength(63);
    expect(first).toMatch(/-[0-9a-f]{12}$/);
    expect(second).toMatch(/-[0-9a-f]{12}$/);
    expect(oversizedSlug).toMatch(/-[0-9a-f]{12}$/);
  });
});
