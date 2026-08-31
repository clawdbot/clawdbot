import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { applyNonInteractiveSkillsConfig } from "./skills-config.js";

describe("non-interactive skills config", () => {
  it.each([
    [undefined, undefined, "npm"],
    ["npm", undefined, "npm"],
    ["pnpm", undefined, "pnpm"],
    ["bun", undefined, "bun"],
    ["yarn", undefined, "yarn"],
    ["yarn", "npm", "npm"],
    ["bun", "pnpm", "pnpm"],
    ["pnpm", "bun", "bun"],
  ] as const)("resolves saved %s with requested %s to %s", (saved, requested, expected) => {
    const nextConfig: OpenClawConfig = {
      skills: { install: { nodeManager: saved, preferBrew: false } },
    };
    const result = applyNonInteractiveSkillsConfig({
      nextConfig,
      opts: { nodeManager: requested },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(result.skills?.install).toEqual({ nodeManager: expected, preferBrew: false });
    expect(nextConfig.skills?.install?.nodeManager).toBe(saved);
  });

  it("leaves skills untouched when setup is skipped, even with an explicit manager", () => {
    const nextConfig: OpenClawConfig = {
      skills: { install: { nodeManager: "yarn", preferBrew: false } },
    };
    expect(
      applyNonInteractiveSkillsConfig({
        nextConfig,
        opts: { skipSkills: true, nodeManager: "npm" },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }),
    ).toEqual(nextConfig);
  });
});
